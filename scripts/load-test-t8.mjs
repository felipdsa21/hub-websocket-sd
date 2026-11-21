#!/usr/bin/env node
/**
 * T8 load test / benchmark (docs/especificacao.md, section 6):
 * - Connects 10 distinct users to the WebSocket API and puts all 10 in one group.
 * - Runs a warm-up round (1 message per user, 100 deliveries) reported separately (R05).
 * - Runs the measured round: all 10 users send 10 messages concurrently, each user waiting
 *   for confirmation of the previous message before sending the next (100 messages -> 1,000 deliveries).
 * - Computes mean, p50, p95, p99, min, max delivery latency, throughput, and checks that
 *   every client orders all messages identically by `sk` (RNF02, RNF04, R06).
 *
 * Usage: node load-test-t8.mjs <wss-url> [--out results.json]
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const url = process.argv[2];
const selfTest = process.argv.includes('--self-test');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const outPath = arg('out', undefined);

if (!selfTest && (!url || !url.startsWith('ws'))) {
  console.error('Usage: node load-test-t8.mjs <wss-url> [--users 10] [--messages 10] [--out results.json]');
  process.exit(1);
}

const USER_COUNT = Number(arg('users', '10'));
const MESSAGES_PER_USER = Number(arg('messages', '10'));
const WARMUP_PER_USER = Number(arg('warmup', '1'));
const RUN_TAG = Date.now().toString(36);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function summarizeLatencies(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    minMs: Number((sorted[0] ?? 0).toFixed(2)),
    avgMs: Number((sorted.length ? sum / sorted.length : 0).toFixed(2)),
    p50Ms: Number(percentile(sorted, 50).toFixed(2)),
    p95Ms: Number(percentile(sorted, 95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 99).toFixed(2)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
  };
}

class BenchClient {
  constructor(username) {
    this.username = username;
    this.pending = new Map();
    this.confirmWaiters = new Map();
    this.messages = new Map();
    this.deliveries = [];
    this.gatewayErrors = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url}?username=${this.username}&displayName=${this.username}`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (err) => reject(err);
      ws.onmessage = (ev) => this.onMessage(ev.data);
    });
  }

  onMessage(raw) {
    const receivedAt = performance.now();
    const data = JSON.parse(String(raw));
    if (!data.type) {
      // API Gateway error without type/requestId (e.g. Lambda concurrency throttling, section 4.2).
      this.gatewayErrors++;
      return;
    }
    if (data.type === 'response' || data.type === 'pong' || data.type === 'error') {
      const p = this.pending.get(data.requestId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(data.requestId);
        if (data.type === 'error') p.reject(new Error(`${data.code}: ${data.message}`));
        else p.resolve(data.data);
      }
      return;
    }
    if (data.type === 'message') {
      const key = `${data.sender}#${data.messageId}`;
      if (!this.messages.has(key)) {
        this.messages.set(key, data);
      }
      this.deliveries.push({
        messageId: data.messageId,
        sender: data.sender,
        recipient: this.username,
        receivedAt,
        sk: data.sk,
      });
      if (data.sender === this.username) {
        const waiter = this.confirmWaiters.get(data.messageId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.confirmWaiters.delete(data.messageId);
          waiter.resolve(receivedAt);
        }
      }
    }
  }

  request(action, fields = {}, timeoutMs = 15_000) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timeout waiting for ${action} (${this.username})`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, requestId, ...fields }));
    });
  }

  async sendMessageAndWaitConfirm(conversationId, text, retryAfterMs = 2_000, maxAttempts = 5) {
    const messageId = randomUUID();
    let retries = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const requestId = randomUUID();
      const sentPerf = performance.now();
      const confirmedAt = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.confirmWaiters.delete(messageId);
          resolve(null);
        }, retryAfterMs);
        this.confirmWaiters.set(messageId, {
          timer,
          resolve: (ts) => resolve(ts),
        });
        this.ws.send(
          JSON.stringify({ action: 'sendMessage', requestId, conversationId, messageId, text }),
        );
      });
      if (confirmedAt !== null) {
        return { messageId, sentPerf, confirmedAt, retries };
      }
      retries++;
      // Small jittered pause before resending the same messageId (RF12).
      await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 200)));
    }
    throw new Error(`Exhausted ${maxAttempts} attempts confirming ${messageId} (${this.username})`);
  }

  sortedSks() {
    return [...this.messages.values()]
      .sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0))
      .map((m) => m.sk);
  }

  close() {
    this.ws?.close();
  }
}

async function runRound(clients, conversationId, perUser, label) {
  const sentTimes = new Map();
  let totalRetries = 0;
  const gatewayErrorsBefore = clients.reduce((acc, c) => acc + c.gatewayErrors, 0);
  const startWall = new Date().toISOString();
  const roundStart = performance.now();

  await Promise.all(
    clients.map(async (client) => {
      for (let i = 0; i < perUser; i++) {
        const res = await client.sendMessageAndWaitConfirm(
          conversationId,
          `${label} #${i + 1} from ${client.username}`,
        );
        totalRetries += res.retries;
        sentTimes.set(res.messageId, { sentPerf: res.sentPerf, sender: client.username });
      }
    }),
  );

  // Wait briefly until all fan-out deliveries arrive at every client (up to 10 s).
  const expectedDeliveries = sentTimes.size * clients.length;
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    let seen = 0;
    for (const c of clients) {
      for (const d of c.deliveries) {
        if (sentTimes.has(d.messageId)) seen++;
      }
    }
    if (seen >= expectedDeliveries) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const roundDurationMs = performance.now() - roundStart;
  const endWall = new Date().toISOString();
  const gatewayErrors = clients.reduce((acc, c) => acc + c.gatewayErrors, 0) - gatewayErrorsBefore;

  const allDeliveryLatencies = [];
  const confirmationLatencies = [];
  const peerDeliveryLatencies = [];
  for (const c of clients) {
    for (const d of c.deliveries) {
      const meta = sentTimes.get(d.messageId);
      if (!meta) continue;
      const latency = Math.max(0, d.receivedAt - meta.sentPerf);
      allDeliveryLatencies.push(latency);
      if (d.recipient === meta.sender) confirmationLatencies.push(latency);
      else peerDeliveryLatencies.push(latency);
    }
  }

  return {
    label,
    startedAt: startWall,
    endedAt: endWall,
    durationMs: Number(roundDurationMs.toFixed(1)),
    messagesSent: sentTimes.size,
    expectedDeliveries,
    receivedDeliveries: allDeliveryLatencies.length,
    retries: totalRetries,
    gatewayErrors,
    throughputMessagesPerSec: Number((sentTimes.size / (roundDurationMs / 1000)).toFixed(2)),
    throughputDeliveriesPerSec: Number(
      (allDeliveryLatencies.length / (roundDurationMs / 1000)).toFixed(2),
    ),
    allDeliveries: summarizeLatencies(allDeliveryLatencies),
    confirmations: summarizeLatencies(confirmationLatencies),
    peerDeliveries: summarizeLatencies(peerDeliveryLatencies),
    rawLatenciesMs: allDeliveryLatencies.map((v) => Number(v.toFixed(2))),
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const usernames = Array.from({ length: USER_COUNT }, (_, i) => `t8_${RUN_TAG}_u${i + 1}`);
  const clients = usernames.map((u) => new BenchClient(u));

  console.log(`Connecting ${USER_COUNT} users to ${url}...`);
  // Connect in batches of 5 to stay below new-account Lambda concurrency quota (10) during setup.
  for (let i = 0; i < clients.length; i += 5) {
    await Promise.all(clients.slice(i, i + 5).map((c) => c.connect()));
  }

  const { conversation } = await clients[0].request('createGroup', {
    name: `T8 Bench ${RUN_TAG}`,
    members: usernames.slice(1),
  });
  const conversationId = conversation.conversationId;
  console.log(`Group created: ${conversationId}`);

  const warmup = await runRound(clients, conversationId, WARMUP_PER_USER, 'warmup');
  console.log('Warm-up:', JSON.stringify({ ...warmup, rawLatenciesMs: undefined }));

  const measured = await runRound(clients, conversationId, MESSAGES_PER_USER, 'measured');
  console.log('Measured:', JSON.stringify({ ...measured, rawLatenciesMs: undefined }));

  // Check identical message ordering across all 10 clients (RNF04).
  const expectedTotal = USER_COUNT * (WARMUP_PER_USER + MESSAGES_PER_USER);
  const refOrder = clients[0].sortedSks();
  const orderConsistent =
    refOrder.length === expectedTotal &&
    clients.every((c) => {
      const sks = c.sortedSks();
      return sks.length === refOrder.length && sks.every((sk, i) => sk === refOrder[i]);
    });
  console.log(
    `Order consistency (RNF04): ${orderConsistent} (${refOrder.length}/${expectedTotal} unique messages)`,
  );

  for (const c of clients) c.close();
  const endedAt = new Date().toISOString();

  const report = {
    startedAt,
    endedAt,
    endpoint: url,
    users: USER_COUNT,
    messagesPerUser: MESSAGES_PER_USER,
    warmupPerUser: WARMUP_PER_USER,
    rnf02TargetP95Ms: 500,
    rnf02Passed: measured.allDeliveries.p95Ms < 500,
    rnf04OrderConsistent: orderConsistent,
    totalUniqueMessages: refOrder.length,
    warmup,
    measured,
  };

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Saved report to ${outPath}`);
  }
  if (!orderConsistent) process.exit(2);
}

if (selfTest) {
  const s = summarizeLatencies([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  if (s.count !== 10 || s.avgMs !== 550 || s.p50Ms !== 500 || s.p95Ms !== 1000 || s.minMs !== 100) {
    console.error('Self-test failed:', s);
    process.exit(1);
  }
  console.log('Self-test passed:', s);
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
