#!/usr/bin/env node
/**
 * Automated integration test suite against the live dev WebSocket API covering:
 * - S4 QA (T3): private chats, groups, room isolation, history, concurrent ordering
 * - S5 QA (T7): idempotent resend without duplicates, abrupt disconnect & sync/getHistory catch-up, presence
 * - S6 QA (Security & Logs): invalid $connect rejected, unauthorized requests rejected with forbidden (RNF01),
 *   $default errors, and CloudWatch log verification (no raw ids or message text, RNF03).
 *
 * Usage: node integration-tests-dev.mjs <wss-url> [--region sa-east-1] [--stage dev] [--out report.json]
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const selfTest = process.argv.includes('--self-test');
const sanitize = process.argv.includes('--sanitize');
const url = process.argv[2];
if (!selfTest && (!url || !url.startsWith('ws'))) {
  console.error('Usage: node integration-tests-dev.mjs <wss-url> [--region sa-east-1] [--stage dev] [--sanitize] [--out report.json]');
  process.exit(1);
}
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const region = arg('region', 'sa-east-1');
const stage = arg('stage', 'dev');
const outPath = arg('out', undefined);
const TAG = Date.now().toString(36);

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

class TestClient {
  constructor(username, displayName = username) {
    this.username = username;
    this.displayName = displayName;
    this.events = [];
    this.pending = new Map();
    this.eventWaiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ username: this.username, displayName: this.displayName });
      const ws = new WebSocket(`${url}?${q.toString()}`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        this.events.push(msg);
        if (msg.requestId && this.pending.has(msg.requestId)) {
          const p = this.pending.get(msg.requestId);
          clearTimeout(p.timer);
          this.pending.delete(msg.requestId);
          p.resolve(msg);
        }
        for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
          const w = this.eventWaiters[i];
          if (w.predicate(msg)) {
            clearTimeout(w.timer);
            this.eventWaiters.splice(i, 1);
            w.resolve(msg);
          }
        }
      };
    });
  }

  request(action, fields = {}, timeoutMs = 15_000) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timeout on ${action} for ${this.username}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, requestId, ...fields }));
    });
  }

  sendRaw(payload) {
    this.ws.send(payload);
  }

  waitForEvent(predicate, timeoutMs = 10_000) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for event on ${this.username}`));
      }, timeoutMs);
      this.eventWaiters.push({ predicate, resolve, timer });
    });
  }

  close() {
    this.ws?.close();
  }
}

function expectHandshakeRejected(queryString) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(queryString ? `${url}?${queryString}` : url);
    const timer = setTimeout(() => reject(new Error('Expected handshake rejection but timed out')), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`Handshake unexpectedly succeeded for query "${queryString}"`));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
}

const results = [];
async function runCase(id, name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    const durationMs = Number((performance.now() - t0).toFixed(1));
    results.push({ id, name, status: 'PASS', durationMs, detail });
    console.log(`PASS [${id}] ${name} (${durationMs} ms)`);
  } catch (err) {
    const durationMs = Number((performance.now() - t0).toFixed(1));
    results.push({ id, name, status: 'FAIL', durationMs, error: String(err) });
    console.error(`FAIL [${id}] ${name}: ${err}`);
  }
}

async function main() {
  const startedAt = Date.now();
  const ua = `qa_${TAG}_a`;
  const ub = `qa_${TAG}_b`;
  const uc = `qa_${TAG}_c`;
  const secretBody = `texto-confidencial-qa-${TAG}`;

  const a = new TestClient(ua, 'QA Alice');
  const b = new TestClient(ub, 'QA Bruno');
  const c = new TestClient(uc, 'QA Carla');

  await Promise.all([a.connect(), b.connect(), c.connect()]);
  let groupId = '';

  await runCase('S4-T3-1', 'Chat privado oculto até 1ª mensagem e isolamento entre usuários', async () => {
    const openRes = await a.request('openDirect', { username: ub });
    assert(openRes.type === 'response', 'openDirect should succeed');
    const directId = openRes.data.conversation.conversationId;

    const syncB1 = await b.request('sync');
    assert(!syncB1.data.conversations.some((x) => x.conversationId === directId), 'direct chat must stay hidden for B before first message');

    const msgId = randomUUID();
    a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: msgId, text: secretBody }));
    const bAdded = await b.waitForEvent((e) => e.type === 'conversationAdded' && e.conversation.conversationId === directId);
    const bMsg = await b.waitForEvent((e) => e.type === 'message' && e.messageId === msgId);
    assert(bAdded && bMsg.sender === ua, 'B must receive conversationAdded and message');
    assert(!c.events.some((e) => e.type === 'message' && e.messageId === msgId), 'C must not receive direct message');
    return { directId };
  });

  await runCase('S4-T3-2', 'Grupo, isolamento, histórico, adição, saída e aviso lastMember', async () => {
    const grp = await a.request('createGroup', { name: `QA Grupo ${TAG}`, members: [uc] });
    assert(grp.type === 'response', 'createGroup failed');
    groupId = grp.data.conversation.conversationId;
    await c.waitForEvent((e) => e.type === 'conversationAdded' && e.conversation.conversationId === groupId);

    const m1 = randomUUID();
    a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: groupId, messageId: m1, text: 'msg-grupo-1' }));
    await c.waitForEvent((e) => e.type === 'message' && e.messageId === m1);
    assert(!b.events.some((e) => e.type === 'message' && e.messageId === m1), 'B must not receive group message before joining');

    // RNF01: B (non-member) refused on sendMessage, getHistory, addMember, leaveGroup
    const rSend = await b.request('sendMessage', { conversationId: groupId, messageId: randomUUID(), text: 'intruso' });
    const rHist = await b.request('getHistory', { conversationId: groupId });
    const rAdd = await b.request('addMember', { conversationId: groupId, username: ub });
    const rLeave = await b.request('leaveGroup', { conversationId: groupId });
    assert(rSend.type === 'error' && rSend.code === 'forbidden', 'sendMessage must return forbidden');
    assert(rHist.type === 'error' && rHist.code === 'forbidden', 'getHistory must return forbidden');
    assert(rAdd.type === 'error' && rAdd.code === 'forbidden', 'addMember must return forbidden');
    assert(rLeave.type === 'error' && rLeave.code === 'forbidden', 'leaveGroup must return forbidden');

    // Add B and verify B sees history
    const addOk = await c.request('addMember', { conversationId: groupId, username: ub });
    assert(addOk.type === 'response', 'addMember by C failed');
    await b.waitForEvent((e) => e.type === 'conversationAdded' && e.conversation.conversationId === groupId);
    const histB = await b.request('getHistory', { conversationId: groupId });
    assert(histB.data.messages.some((m) => m.messageId === m1), 'B must see prior group history');

    // Concurrent sends -> identical sk ordering across A, B, C
    const concurrentIds = [randomUUID(), randomUUID(), randomUUID()];
    a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: groupId, messageId: concurrentIds[0], text: 'c-a' }));
    b.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: groupId, messageId: concurrentIds[1], text: 'c-b' }));
    c.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: groupId, messageId: concurrentIds[2], text: 'c-c' }));
    for (const id of concurrentIds) {
      await Promise.all([
        a.waitForEvent((e) => e.type === 'message' && e.messageId === id),
        b.waitForEvent((e) => e.type === 'message' && e.messageId === id),
        c.waitForEvent((e) => e.type === 'message' && e.messageId === id),
      ]);
    }
    const concurrentSet = new Set(concurrentIds);
    const order = (cli) =>
      cli.events
        .filter((e) => e.type === 'message' && e.conversationId === groupId && concurrentSet.has(e.messageId))
        .sort((x, y) => (x.sk < y.sk ? -1 : x.sk > y.sk ? 1 : 0))
        .map((e) => e.sk);
    assert(order(a).length === 3 && JSON.stringify(order(a)) === JSON.stringify(order(b)) && JSON.stringify(order(b)) === JSON.stringify(order(c)), 'Ordering must match across all clients');

    // Leave group and lastMember confirmation
    assert((await c.request('leaveGroup', { conversationId: groupId })).type === 'response', 'C leave failed');
    assert((await a.request('leaveGroup', { conversationId: groupId })).type === 'response', 'A leave failed');
    const lastErr = await b.request('leaveGroup', { conversationId: groupId });
    assert(lastErr.type === 'error' && lastErr.code === 'lastMember', 'B leaving last without confirm must return lastMember');
    const lastOk = await b.request('leaveGroup', { conversationId: groupId, confirm: true });
    assert(lastOk.type === 'response', 'B leaving last with confirm must succeed');
    return { groupId, concurrentVerified: 3 };
  });

  await runCase('S5-T7-1', 'Reenvio idempotente (RF12) e mesmo messageId por outro remetente', async () => {
    const directId = (await a.request('openDirect', { username: ub })).data.conversation.conversationId;
    const sharedId = randomUUID();
    a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: sharedId, text: 'idem-1' }));
    await a.waitForEvent((e) => e.type === 'message' && e.messageId === sharedId);
    await b.waitForEvent((e) => e.type === 'message' && e.messageId === sharedId);

    const bCountBefore = b.events.filter((e) => e.type === 'message' && e.messageId === sharedId && e.sender === ua).length;
    // Resend same messageId from A
    a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: sharedId, text: 'idem-1' }));
    await new Promise((r) => setTimeout(r, 1200));
    const bCountAfter = b.events.filter((e) => e.type === 'message' && e.messageId === sharedId && e.sender === ua).length;
    assert(bCountAfter === bCountBefore, 'Resend must not duplicate delivery to B');

    // Different sender reusing same messageId must succeed
    b.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: sharedId, text: 'idem-from-b' }));
    const fromB = await a.waitForEvent((e) => e.type === 'message' && e.messageId === sharedId && e.sender === ub);
    assert(fromB.text === 'idem-from-b', 'Another sender reusing messageId must be delivered');
    return { sharedId };
  });

  await runCase('S5-T7-2', 'Desconexão, presença offline em tempo real e recuperação via sync + getHistory(after)', async () => {
    const directId = (await a.request('openDirect', { username: ub })).data.conversation.conversationId;
    const syncBefore = await b.request('sync');
    const histBefore = await b.request('getHistory', { conversationId: directId });
    const lastSk = histBefore.data.messages.at(-1).sk;

    // Close B and confirm A gets presence offline
    b.close();
    const offEv = await a.waitForEvent((e) => e.type === 'presence' && e.username === ub && e.online === false);
    assert(offEv.online === false, 'A must receive offline presence for B');

    // A sends message while B is offline
    const missedId = randomUUID();
    a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: missedId, text: 'enquanto-offline' }));
    await a.waitForEvent((e) => e.type === 'message' && e.messageId === missedId);

    // B reconnects and syncs with since
    const b2 = new TestClient(ub, 'QA Bruno');
    await b2.connect();
    const onEv = await a.waitForEvent((e) => e.type === 'presence' && e.username === ub && e.online === true && e.version > offEv.version);
    assert(onEv.online === true, 'A must receive online presence when B reconnects');

    const syncAfter = await b2.request('sync', { since: Math.max(0, syncBefore.data.serverTime - 30_000) });
    assert(syncAfter.data.updated.includes(directId), 'sync(since) must include updated direct chat');
    const catchup = await b2.request('getHistory', { conversationId: directId, after: lastSk });
    assert(catchup.data.messages.some((m) => m.messageId === missedId), 'getHistory(after) must return missed message');
    b2.close();
    return { missedId, offlineVersion: offEv.version, onlineVersion: onEv.version };
  });

  await runCase('S6-SEC-1', 'Rejeição de conexões inválidas ($connect) e rotas desconhecidas / não-JSON ($default)', async () => {
    await expectHandshakeRejected('');
    await expectHandshakeRejected('username=a');
    await expectHandshakeRejected('username=invalido%20espaco');

    const badAction = await a.request('acaoInexistente', {});
    assert(badAction.type === 'error' && badAction.code === 'unknownAction', 'unknownAction expected on $default');

    a.sendRaw('{nao-e-json');
    const nonJson = await a.waitForEvent((e) => e.type === 'error' && e.code === 'unknownAction' && !e.requestId);
    assert(Boolean(nonJson), 'Non-JSON payload must return unknownAction from $default');
    return { handshakeCasesRejected: 3 };
  });

  a.close();
  c.close();

  await runCase('S6-LOGS-1', 'Logs estruturados e anonimizados no CloudWatch sem identificadores em claro nem texto (RNF03)', async () => {
    // Allow CloudWatch Logs ingestion lag (~4 s)
    await new Promise((r) => setTimeout(r, 4000));
    const groups = JSON.parse(
      execFileSync('aws', ['--region', region, 'logs', 'describe-log-groups', '--log-group-name-prefix', `/aws/lambda/HubWebSocket-${stage}-app`, '--output', 'json'], { encoding: 'utf8' }),
    ).logGroups;
    const logGroup = groups[0]?.logGroupName;
    assert(Boolean(logGroup), 'app log group not found');

    const events = JSON.parse(
      execFileSync('aws', ['--region', region, 'logs', 'filter-log-events', '--log-group-name', logGroup, '--start-time', String(startedAt - 10_000), '--output', 'json'], { encoding: 'utf8' }),
    ).events;
    const jsonLines = events
      .map((e) => {
        const idx = e.message.indexOf('{"route":');
        if (idx < 0) return null;
        try { return JSON.parse(e.message.slice(idx)); } catch { return null; }
      })
      .filter(Boolean);

    assert(jsonLines.length > 0, 'Expected structured JSON logs in CloudWatch');
    const allRaw = events.map((e) => e.message).join('\n');
    assert(!allRaw.includes(ua), `Raw username ${ua} leaked in logs!`);
    assert(!allRaw.includes(ub), `Raw username ${ub} leaked in logs!`);
    assert(!allRaw.includes(uc), `Raw username ${uc} leaked in logs!`);
    assert(!allRaw.includes(secretBody), 'Message text leaked in logs!');
    if (groupId) assert(!allRaw.includes(groupId), 'Raw conversationId leaked in logs!');

    const sample = jsonLines.find((l) => l.route === 'sendMessage' && l.connectionId && l.username && l.conversationId);
    assert(Boolean(sample), 'Expected anonymized sendMessage log entry');
    assert(/^[0-9a-f]{12}$/.test(sample.connectionId), 'connectionId must be 12 hex');
    assert(/^[0-9a-f]{12}$/.test(sample.username), 'username must be 12 hex');
    assert(/^[0-9a-f]{12}$/.test(sample.conversationId), 'conversationId must be 12 hex');
    const dupLog = jsonLines.find((l) => l.route === 'sendMessage' && l.result === 'duplicate');
    const forbLog = jsonLines.find((l) => l.code === 'forbidden');
    assert(Boolean(dupLog), 'Expected result=duplicate log entry from resend test');
    assert(Boolean(forbLog), 'Expected code=forbidden log entry from unauthorized test');

    return { logGroup, structuredLines: jsonLines.length, sample, dupLog, forbLog };
  });

  const passed = results.filter((r) => r.status === 'PASS').length;
  const sanitizedResults = sanitize
    ? results.map((r) =>
        r.detail && typeof r.detail === 'object' && 'logGroup' in r.detail
          ? { ...r, detail: { ...r.detail, logGroup: `/aws/lambda/HubWebSocket-${stage}-app-<id>` } }
          : r,
      )
    : results;
  const report = {
    executedAt: new Date().toISOString(),
    endpoint: sanitize ? `wss://<api-id>.execute-api.${region}.amazonaws.com/${stage}` : url,
    stage,
    region,
    passed,
    total: results.length,
    results: sanitizedResults,
  };
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Saved integration report to ${outPath}`);
  }
  console.log(`\nSummary: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

if (selfTest) {
  assert(true, 'ok');
  let threw = false;
  try {
    assert(false, 'expected');
  } catch {
    threw = true;
  }
  if (!threw) process.exit(1);
  console.log('Self-test passed');
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
