#!/usr/bin/env node
/**
 * T8 load test / benchmark (docs/especificacao.md, section 6):
 * - Connects N distinct users (default 10) to the WebSocket API and puts all in one group.
 * - Runs a warm-up round (1 message per user by default) reported separately (R05).
 * - Runs the measured round: all users send M messages concurrently, each user waiting
 *   for confirmation of the previous message before sending the next (100 messages -> 1,000 deliveries).
 * - Computes mean, p50, p95, p99, min, max end-to-end delivery latency, throughput, and checks that
 *   every client orders all messages identically by `sk` (RNF02, RNF04, R06).
 *
 * Usage: node load-test-t8.mjs <wss-url> [--users 10] [--messages 10] [--warmup 1] [--out results.json]
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const USAGE =
  'Usage: node load-test-t8.mjs <wss-url> [--users 10] [--messages 10] [--warmup 1] [--out results.json]';

function parseIntArg(flag, raw, min, max = Number.MAX_SAFE_INTEGER) {
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function parseCliArgs(argv) {
  let selfTest = false;
  let url;
  let users = 10;
  let messages = 10;
  let warmup = 1;
  let outPath;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--self-test') {
      selfTest = true;
    } else if (token === '--users') {
      users = parseIntArg('--users', argv[++i], 2, 99);
    } else if (token === '--messages') {
      messages = parseIntArg('--messages', argv[++i], 1);
    } else if (token === '--warmup') {
      warmup = parseIntArg('--warmup', argv[++i], 0);
    } else if (token === '--out') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error('Missing value for --out');
      outPath = next;
    } else if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    } else if (url === undefined) {
      url = token;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }

  if (!selfTest) {
    if (!url) throw new Error('Missing <wss-url>');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid WebSocket URL: "${url}"`);
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error(`URL must use ws:// or wss:// protocol (got "${parsed.protocol}")`);
    }
  }

  return { selfTest, url, users, messages, warmup, outPath };
}

function sanitizeEndpoint(rawUrl) {
  return rawUrl.replace(/^(wss?:\/\/)[^.]+\.(execute-api\.[^/]+)/, '$1<api-id>.$2');
}

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
  constructor(username, endpointUrl) {
    this.username = username;
    this.endpointUrl = endpointUrl;
    this.pending = new Map();
    this.confirmWaiters = new Map();
    this.messages = new Map();
    this.firstReceivedAt = new Map();
    this.deliveries = [];
    this.gatewayErrors = 0;
    this.duplicateDeliveries = 0;
  }

  clearWaiters(reason) {
    const err = new Error(reason);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const w of this.confirmWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.confirmWaiters.clear();
  }

  connect(timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const wsUrl = new URL(this.endpointUrl);
      wsUrl.searchParams.set('username', this.username);
      wsUrl.searchParams.set('displayName', this.username);
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error(`Timeout connecting ${this.username}`));
      }, timeoutMs);

      ws.onopen = () => {
        if (settled) {
          ws.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        reject(new Error(`WebSocket error connecting ${this.username}`));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before open (${this.username})`));
          return;
        }
        this.clearWaiters(`WebSocket closed (${this.username})`);
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
    });
  }

  onMessage(raw) {
    const receivedAt = performance.now();
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      this.gatewayErrors++;
      return;
    }
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
        this.firstReceivedAt.set(key, receivedAt);
        this.deliveries.push({
          messageId: data.messageId,
          sender: data.sender,
          recipient: this.username,
          receivedAt,
          sk: data.sk,
        });
      } else {
        this.duplicateDeliveries++;
      }
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`WebSocket is not open for ${action} (${this.username})`));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timeout waiting for ${action} (${this.username})`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, requestId, ...fields }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  async sendMessageAndWaitConfirm(conversationId, text, retryAfterMs = 2_000, maxAttempts = 5) {
    const messageId = randomUUID();
    const ownKey = `${this.username}#${messageId}`;
    // Measure from the initial attempt so retries reflect real end-to-end latency and never invert against earlier deliveries.
    const firstSentPerf = performance.now();
    let retries = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const alreadyConfirmedAt = this.firstReceivedAt.get(ownKey);
      if (alreadyConfirmedAt !== undefined) {
        return { messageId, sentPerf: firstSentPerf, confirmedAt: alreadyConfirmedAt, retries };
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`WebSocket is not open while sending ${messageId} (${this.username})`);
      }

      const requestId = randomUUID();
      const confirmedAt = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.confirmWaiters.delete(messageId);
          resolve(null);
        }, retryAfterMs);
        this.confirmWaiters.set(messageId, { timer, resolve, reject });
        try {
          this.ws.send(
            JSON.stringify({ action: 'sendMessage', requestId, conversationId, messageId, text }),
          );
        } catch (err) {
          clearTimeout(timer);
          this.confirmWaiters.delete(messageId);
          reject(err);
        }
      });

      if (confirmedAt !== null) {
        return { messageId, sentPerf: firstSentPerf, confirmedAt, retries };
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`WebSocket closed while confirming ${messageId} (${this.username})`);
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
    this.clearWaiters(`Client closed (${this.username})`);
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.ws.close();
    }
  }
}

async function runRound(clients, conversationId, perUser, label) {
  const sentTimes = new Map();
  let totalRetries = 0;
  const gatewayErrorsBefore = clients.reduce((acc, c) => acc + c.gatewayErrors, 0);
  const duplicatesBefore = clients.reduce((acc, c) => acc + c.duplicateDeliveries, 0);
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

  // Wait briefly until all unique fan-out deliveries arrive at every client (up to 10 s).
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
  const roundDurationSec = roundDurationMs > 0 ? roundDurationMs / 1000 : 0;
  const endWall = new Date().toISOString();
  const gatewayErrors = clients.reduce((acc, c) => acc + c.gatewayErrors, 0) - gatewayErrorsBefore;
  const duplicateDeliveries =
    clients.reduce((acc, c) => acc + c.duplicateDeliveries, 0) - duplicatesBefore;

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
    duplicateDeliveries,
    retries: totalRetries,
    gatewayErrors,
    throughputMessagesPerSec:
      roundDurationSec > 0 ? Number((sentTimes.size / roundDurationSec).toFixed(2)) : 0,
    throughputDeliveriesPerSec:
      roundDurationSec > 0 ? Number((allDeliveryLatencies.length / roundDurationSec).toFixed(2)) : 0,
    allDeliveries: summarizeLatencies(allDeliveryLatencies),
    confirmations: summarizeLatencies(confirmationLatencies),
    peerDeliveries: summarizeLatencies(peerDeliveryLatencies),
    rawLatenciesMs: allDeliveryLatencies.map((v) => Number(v.toFixed(2))),
  };
}

async function main(opts) {
  const startedAt = new Date().toISOString();
  const runTag = Date.now().toString(36);
  const usernames = Array.from({ length: opts.users }, (_, i) => `t8_${runTag}_u${i + 1}`);
  const clients = usernames.map((u) => new BenchClient(u, opts.url));

  let warmup;
  let measured;
  let orderConsistent = false;
  let refOrder = [];

  try {
    console.log(`Connecting ${opts.users} users to ${sanitizeEndpoint(opts.url)}...`);
    // Connect in batches of 5 to stay below new-account Lambda concurrency quota (10) during setup.
    for (let i = 0; i < clients.length; i += 5) {
      await Promise.all(clients.slice(i, i + 5).map((c) => c.connect()));
    }

    const { conversation } = await clients[0].request('createGroup', {
      name: `T8 Bench ${runTag}`,
      members: usernames.slice(1),
    });
    const conversationId = conversation.conversationId;
    console.log(`Group created: ${conversationId}`);

    warmup = await runRound(clients, conversationId, opts.warmup, 'warmup');
    console.log('Warm-up:', JSON.stringify({ ...warmup, rawLatenciesMs: undefined }));

    measured = await runRound(clients, conversationId, opts.messages, 'measured');
    console.log('Measured:', JSON.stringify({ ...measured, rawLatenciesMs: undefined }));

    // Check identical message ordering across all clients (RNF04).
    const expectedTotal = opts.users * (opts.warmup + opts.messages);
    refOrder = clients[0].sortedSks();
    orderConsistent =
      refOrder.length === expectedTotal &&
      clients.every((c) => {
        const sks = c.sortedSks();
        return sks.length === refOrder.length && sks.every((sk, i) => sk === refOrder[i]);
      });
    console.log(
      `Order consistency (RNF04): ${orderConsistent} (${refOrder.length}/${expectedTotal} unique messages)`,
    );
  } finally {
    for (const c of clients) c.close();
  }

  const endedAt = new Date().toISOString();
  const report = {
    startedAt,
    endedAt,
    endpoint: sanitizeEndpoint(opts.url),
    users: opts.users,
    messagesPerUser: opts.messages,
    warmupPerUser: opts.warmup,
    rnf02TargetP95Ms: 500,
    rnf02Passed: measured.allDeliveries.p95Ms < 500,
    rnf04OrderConsistent: orderConsistent,
    totalUniqueMessages: refOrder.length,
    warmup,
    measured,
  };

  if (opts.outPath) {
    writeFileSync(opts.outPath, JSON.stringify(report, null, 2));
    console.log(`Saved report to ${opts.outPath}`);
  }
  if (!orderConsistent) process.exit(2);
}

async function runSelfTest() {
  const s = summarizeLatencies([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  assert.deepEqual(s, {
    count: 10,
    minMs: 100,
    avgMs: 550,
    p50Ms: 500,
    p95Ms: 1000,
    p99Ms: 1000,
    maxMs: 1000,
  });
  assert.equal(summarizeLatencies([]).count, 0);

  const parsed = parseCliArgs([
    '--users',
    '5',
    'wss://abc123.execute-api.sa-east-1.amazonaws.com/dev',
    '--messages',
    '10',
    '--warmup',
    '0',
    '--out',
    'out.json',
  ]);
  assert.equal(parsed.users, 5);
  assert.equal(parsed.messages, 10);
  assert.equal(parsed.warmup, 0);
  assert.equal(parsed.outPath, 'out.json');
  assert.equal(
    sanitizeEndpoint(parsed.url),
    'wss://<api-id>.execute-api.sa-east-1.amazonaws.com/dev',
  );

  for (const bad of [
    [],
    ['http://localhost:8080'],
    ['wss://localhost', '--users'],
    ['wss://localhost', '--users', '1'],
    ['wss://localhost', '--users', '100'],
    ['wss://localhost', '--messages', '0'],
    ['wss://localhost', '--warmup', '-1'],
    ['wss://localhost', '--out'],
    ['wss://localhost', '--unknown'],
  ]) {
    assert.throws(() => parseCliArgs(bad));
  }

  // Deduplication on duplicate deliveries (e.g. handleResend after timeout) and gatewayErrors on bad JSON.
  const c = new BenchClient('u1', 'wss://localhost');
  const frame = JSON.stringify({
    type: 'message',
    sender: 'u1',
    messageId: 'm1',
    sk: 'm#0001#u1#m1',
  });
  c.onMessage(frame);
  c.onMessage(frame);
  c.onMessage('not-json');
  assert.equal(c.deliveries.length, 1);
  assert.equal(c.duplicateDeliveries, 1);
  assert.equal(c.gatewayErrors, 1);
  assert.deepEqual(c.sortedSks(), ['m#0001#u1#m1']);

  // Verify retry keeps firstSentPerf (total latency) rather than resetting sentPerf on the last attempt.
  const retryClient = new BenchClient('u1', 'wss://localhost');
  let sendCount = 0;
  retryClient.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sendCount++;
      const parsedPayload = JSON.parse(payload);
      if (sendCount === 2) {
        setTimeout(() => {
          retryClient.onMessage(
            JSON.stringify({
              type: 'message',
              sender: 'u1',
              messageId: parsedPayload.messageId,
              sk: `m#0002#u1#${parsedPayload.messageId}`,
            }),
          );
        }, 10);
      }
    },
    close() {
      this.readyState = WebSocket.CLOSED;
    },
  };
  const t0 = performance.now();
  const res = await retryClient.sendMessageAndWaitConfirm('conv1', 'hello', 25, 3);
  assert.equal(res.retries, 1);
  assert.ok(res.sentPerf >= t0 && res.sentPerf < t0 + 25);
  assert.ok(res.confirmedAt - res.sentPerf >= 120);

  // Verify close() rejects pending waiters and transitions socket cleanly.
  const pendingReq = retryClient.request('sync', {}, 10_000);
  retryClient.close();
  await assert.rejects(pendingReq, /Client closed/);

  console.log('Self-test passed:', s);
}

let cliOpts;
try {
  cliOpts = parseCliArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  console.error(USAGE);
  process.exit(1);
}

if (cliOpts.selfTest) {
  runSelfTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main(cliOpts).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
