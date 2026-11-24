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

function parseCliArgs(argv) {
  const selfTest = argv.includes('--self-test');
  const sanitize = argv.includes('--sanitize');
  const arg = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const val = argv[i + 1];
    if (!val || val.startsWith('--')) throw new Error(`Missing value for --${name}`);
    return val;
  };
  const url = argv[2];
  if (!selfTest) {
    let parsed = null;
    try {
      if (url && !url.startsWith('--')) parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')) {
      throw new Error('Usage: node integration-tests-dev.mjs <wss-url> [--region sa-east-1] [--stage dev] [--sanitize] [--out report.json]');
    }
  }
  return {
    selfTest,
    sanitize,
    url,
    region: arg('region', 'sa-east-1'),
    stage: arg('stage', 'dev'),
    outPath: arg('out', undefined),
  };
}

let url = '';
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

  connect(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ username: this.username, displayName: this.displayName });
      const ws = new WebSocket(`${url}?${q.toString()}`);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error(`Timeout connecting ${this.username}`));
      }, timeoutMs);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      };
      ws.onclose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`WebSocket closed during connect for ${this.username}`));
      };
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
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this.eventWaiters.indexOf(waiter);
        if (idx >= 0) this.eventWaiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for event on ${this.username}`));
      }, timeoutMs);
      this.eventWaiters.push(waiter);
    });
  }

  close() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Client ${this.username} closed`));
    }
    this.pending.clear();
    for (const w of this.eventWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error(`Client ${this.username} closed`));
    }
    this.eventWaiters.length = 0;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }
  }
}

function expectHandshakeRejected(queryString) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(queryString ? `${url}?${queryString}` : url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error('Expected handshake rejection but timed out'));
    }, 10_000);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(new Error(`Handshake unexpectedly succeeded for query "${queryString}"`));
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
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

function buildReport({ endpoint, stage, region, sanitize, caseResults }) {
  const passed = caseResults.filter((r) => r.status === 'PASS').length;
  const sanitizedResults = sanitize
    ? caseResults.map((r) => {
        if (!r.detail || typeof r.detail !== 'object') return r;
        const next = { ...r.detail };
        if ('logGroup' in next) next.logGroup = `HubWebSocket-${stage}-appLogs-<id>`;
        if ('sweeperLogGroup' in next) next.sweeperLogGroup = `HubWebSocket-${stage}-presenceSweeperLogs-<id>`;
        return { ...r, detail: next };
      })
    : caseResults;
  return {
    executedAt: new Date().toISOString(),
    endpoint: sanitize ? `wss://<api-id>.execute-api.${region}.amazonaws.com/${stage}` : endpoint,
    stage,
    region,
    passed,
    total: caseResults.length,
    results: sanitizedResults,
  };
}

function awsJson(region, args) {
  const out = execFileSync('aws', ['--region', region, ...args, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
}

function resolveStackResources(region, stage) {
  const summaries = awsJson(region, [
    'cloudformation',
    'list-stack-resources',
    '--stack-name',
    `HubWebSocket-${stage}`,
  ]).StackResourceSummaries;
  const find = (type, prefix) =>
    summaries.find((r) => r.ResourceType === type && r.LogicalResourceId.startsWith(prefix))
      ?.PhysicalResourceId;
  return {
    appLogGroup: find('AWS::Logs::LogGroup', 'appLogs'),
    sweeperLogGroup: find('AWS::Logs::LogGroup', 'presenceSweeperLogs'),
    connectionsTable: find('AWS::DynamoDB::Table', 'Connections'),
    usersTable: find('AWS::DynamoDB::Table', 'Users'),
  };
}

function seedFakeConnection(region, tables, { connectionId, username, connectedAt, lastSeenAt }) {
  const expiresAt = Math.floor(connectedAt / 1000) + 3 * 3600;
  awsJson(region, [
    'dynamodb',
    'put-item',
    '--table-name',
    tables.connectionsTable,
    '--item',
    JSON.stringify({
      connectionId: { S: connectionId },
      username: { S: username },
      connectedAt: { N: String(connectedAt) },
      lastSeenAt: { N: String(lastSeenAt) },
      expiresAt: { N: String(expiresAt) },
    }),
  ]);
  // Increment version and match announcedVersion so presenceSweeper does not prematurely re-announce (architecture, section 3.4).
  const userItem = awsJson(region, [
    'dynamodb',
    'get-item',
    '--table-name',
    tables.usersTable,
    '--consistent-read',
    '--key',
    JSON.stringify({ username: { S: username } }),
  ]).Item;
  const nextVersion = Number(userItem?.version?.N ?? '1') + 1;
  awsJson(region, [
    'dynamodb',
    'update-item',
    '--table-name',
    tables.usersTable,
    '--key',
    JSON.stringify({ username: { S: username } }),
    '--update-expression',
    'ADD #c :c SET version = :v, announcedVersion = :v, changedAt = :now',
    '--expression-attribute-names',
    JSON.stringify({ '#c': 'connections' }),
    '--expression-attribute-values',
    JSON.stringify({
      ':c': { SS: [connectionId] },
      ':v': { N: String(nextVersion) },
      ':now': { N: String(Date.now()) },
    }),
  ]);
}

async function main(opts) {
  url = opts.url;
  const { region, stage, sanitize, outPath } = opts;
  const startedAt = Date.now();
  const ua = `qa_${TAG}_a`;
  const ub = `qa_${TAG}_b`;
  const uc = `qa_${TAG}_c`;
  const secretBody = `texto-confidencial-qa-${TAG}`;

  const a = new TestClient(ua, 'QA Alice');
  const b = new TestClient(ub, `João Antônio ${TAG}`);
  const c = new TestClient(uc, 'QA Carla');
  const stackRes = resolveStackResources(region, stage);
  let groupId = '';
  let directId = '';

  try {
    await Promise.all([a.connect(), b.connect(), c.connect()]);

    await runCase('S4-T3-1', 'Chat privado oculto até 1ª mensagem e isolamento entre usuários', async () => {
      const openRes = await a.request('openDirect', { username: ub });
      assert(openRes.type === 'response', 'openDirect should succeed');
      directId = openRes.data.conversation.conversationId;

      const syncB1 = await b.request('sync');
      assert(syncB1.type === 'response', 'sync for B should succeed');
      assert(!syncB1.data.conversations.some((x) => x.conversationId === directId), 'direct chat must stay hidden for B before first message');

      const msgId = randomUUID();
      a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: msgId, text: secretBody }));
      const [bAdded, bMsg] = await Promise.all([
        b.waitForEvent((e) => e.type === 'conversationAdded' && e.conversation.conversationId === directId),
        b.waitForEvent((e) => e.type === 'message' && e.messageId === msgId),
        a.waitForEvent((e) => e.type === 'message' && e.messageId === msgId),
      ]);
      assert(bAdded && bMsg.sender === ua && bMsg.text === secretBody, 'B must receive conversationAdded and message');
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
      assert(histB.type === 'response' && histB.data.messages.some((m) => m.messageId === m1), 'B must see prior group history');

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
      assert(
        order(a).length === 3 &&
          new Set(order(a)).size === 3 &&
          JSON.stringify(order(a)) === JSON.stringify(order(b)) &&
          JSON.stringify(order(b)) === JSON.stringify(order(c)),
        'Ordering must match across all clients',
      );

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
      const openRes = await a.request('openDirect', { username: ub });
      assert(openRes.type === 'response', 'openDirect should succeed');
      const directId = openRes.data.conversation.conversationId;
      const sharedId = randomUUID();
      a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: sharedId, text: 'idem-1' }));
      await a.waitForEvent((e) => e.type === 'message' && e.messageId === sharedId && e.sender === ua);
      await b.waitForEvent((e) => e.type === 'message' && e.messageId === sharedId && e.sender === ua);

      const bCountBefore = b.events.filter((e) => e.type === 'message' && e.messageId === sharedId && e.sender === ua).length;
      // Resend same messageId from A and wait for sender confirmation before checking B
      a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: sharedId, text: 'idem-1' }));
      await a.waitForEvent(() => a.events.filter((e) => e.type === 'message' && e.messageId === sharedId && e.sender === ua).length >= 2);
      await new Promise((r) => setTimeout(r, 300));
      const bCountAfter = b.events.filter((e) => e.type === 'message' && e.messageId === sharedId && e.sender === ua).length;
      assert(bCountAfter === bCountBefore, 'Resend must not duplicate delivery to B');

      // Different sender reusing same messageId must succeed
      b.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: sharedId, text: 'idem-from-b' }));
      const fromB = await a.waitForEvent((e) => e.type === 'message' && e.messageId === sharedId && e.sender === ub);
      assert(fromB.text === 'idem-from-b', 'Another sender reusing messageId must be delivered');
      return { sharedId };
    });

    await runCase('S5-T7-2', 'Desconexão, presença offline em tempo real e recuperação via sync + getHistory(after)', async () => {
      const openRes = await a.request('openDirect', { username: ub });
      assert(openRes.type === 'response', 'openDirect should succeed');
      const directId = openRes.data.conversation.conversationId;
      const syncBefore = await b.request('sync');
      assert(syncBefore.type === 'response', 'sync before disconnect failed');
      const histBefore = await b.request('getHistory', { conversationId: directId });
      assert(histBefore.type === 'response' && histBefore.data.messages.length > 0, 'getHistory before disconnect failed');
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
      const b2 = new TestClient(ub, `João Antônio ${TAG}`);
      try {
        await b2.connect();
        const onEv = await a.waitForEvent((e) => e.type === 'presence' && e.username === ub && e.online === true && e.version > offEv.version);
        assert(onEv.online === true, 'A must receive online presence when B reconnects');

        const syncAfter = await b2.request('sync', { since: Math.max(0, syncBefore.data.serverTime - 30_000) });
        assert(syncAfter.type === 'response' && syncAfter.data.updated.includes(directId), 'sync(since) must include updated direct chat');
        const catchup = await b2.request('getHistory', { conversationId: directId, after: lastSk });
        assert(catchup.type === 'response' && catchup.data.messages.some((m) => m.messageId === missedId), 'getHistory(after) must return missed message');
        return { missedId, offlineVersion: offEv.version, onlineVersion: onEv.version };
      } finally {
        b2.close();
      }
    });

    await runCase('S4-T2-SIZE', 'Mensagem perto do limite de 32 KB (RF11) entregue e paginada em getHistory', async () => {
      const bigText = 'á'.repeat(15_800); // 31.600 bytes UTF-8 (abaixo do frame de 32 KB)
      const bigId = randomUUID();
      a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: bigId, text: bigText }));
      const ev = await a.waitForEvent((e) => e.type === 'message' && e.messageId === bigId);
      assert(ev.text === bigText, 'Large UTF-8 message must match byte-for-byte');
      const hist = await a.request('getHistory', { conversationId: directId });
      assert(hist.type === 'response' && hist.data.messages.some((m) => m.messageId === bigId), 'Large message must appear in getHistory');
      return { utf8Bytes: Buffer.byteLength(bigText, 'utf8') };
    });

    await runCase('S4-T4-SEARCH', 'Pesquisa normalizada pt-BR (sem acento encontra com acento) e presença (RF05)', async () => {
      const res = await c.request('search', { query: `joao antonio ${TAG}` });
      assert(res.type === 'response', 'search failed');
      const found = res.data.people.find((p) => p.username === ub);
      assert(Boolean(found) && typeof found.online === 'boolean', 'Accent-insensitive search must find João Antônio with presence');
      return { matchedUsername: found.username, displayName: found.displayName, online: found.online };
    });

    await runCase('S4-T5-HISTORY', 'Histórico > 128 KB paginado em múltiplas páginas via getHistory(before) (RF06, T5)', async () => {
      const grp5 = await a.request('createGroup', { name: `QA Hist ${TAG}`, members: [c.username] });
      assert(grp5.type === 'response', 'createGroup for T5 failed');
      const cid5 = grp5.data.conversation.conversationId;
      const chunk = 'H'.repeat(28_000);
      const sentIds = [];
      for (let i = 0; i < 5; i++) {
        const mid = randomUUID();
        sentIds.push(mid);
        a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: cid5, messageId: mid, text: `${i}:${chunk}` }));
        await a.waitForEvent((e) => e.type === 'message' && e.messageId === mid);
      }
      const seen = new Set();
      let pages = 0;
      let before;
      while (true) {
        const res = await c.request('getHistory', before ? { conversationId: cid5, before } : { conversationId: cid5 });
        assert(res.type === 'response', 'getHistory page failed');
        pages++;
        for (const m of res.data.messages) seen.add(m.messageId);
        if (!res.data.hasMore) break;
        before = res.data.messages[0].sk;
        assert(pages < 20, 'Too many pages');
      }
      assert(pages >= 5 && sentIds.every((id) => seen.has(id)), `Expected >=5 pages and all 5 msgs (got pages=${pages}, seen=${seen.size})`);
      return { totalBytes: 5 * 28_002, pages, messagesRecovered: seen.size };
    });

    await runCase('S5-T6-MULTITAB', 'Presença multi-aba: fechar 1ª mantém online; fechar 2ª anuncia offline (T6, RF07)', async () => {
      const bTab1 = new TestClient(ub, `João Antônio ${TAG}`);
      const bTab2 = new TestClient(ub, `João Antônio ${TAG}`);
      try {
        await bTab1.connect();
        await bTab2.connect();
        const mid = randomUUID();
        a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: mid, text: 'multi-aba' }));
        await Promise.all([
          bTab1.waitForEvent((e) => e.type === 'message' && e.messageId === mid),
          bTab2.waitForEvent((e) => e.type === 'message' && e.messageId === mid),
        ]);
        const eventsBefore = a.events.length;
        bTab1.close();
        const stillOn = await a.waitForEvent((e) => a.events.indexOf(e) >= eventsBefore && e.type === 'presence' && e.username === ub);
        assert(stillOn.online === true, 'User B must stay online after closing 1 of 2 tabs');
        const eventsBefore2 = a.events.length;
        bTab2.close();
        const nowOff = await a.waitForEvent((e) => a.events.indexOf(e) >= eventsBefore2 && e.type === 'presence' && e.username === ub && e.online === false);
        assert(nowOff.online === false, 'User B must become offline after closing last tab');
        return { stillOnlineVersion: stillOn.version, offlineVersion: nowOff.version };
      } finally {
        bTab1.close();
        bTab2.close();
      }
    });

    await runCase('S5-T7-410-GONE', 'Tratamento real de 410 Gone (GoneException): desvínculo e confirmação ao remetente (T7.1, RF08)', async () => {
      // Connect a real socket to obtain a genuine API Gateway connectionId, then close it and re-seed it (T7.1).
      const bReal = new TestClient(ub, `João Antônio ${TAG}`);
      await bReal.connect();
      const userRec = awsJson(region, [
        'dynamodb',
        'get-item',
        '--table-name',
        stackRes.usersTable,
        '--consistent-read',
        '--key',
        JSON.stringify({ username: { S: ub } }),
      ]).Item;
      const staleId = userRec?.connections?.SS?.[0];
      assert(Boolean(staleId), 'Expected real connectionId for B in Users table');
      const eventsBeforeClose = a.events.length;
      bReal.close();
      await a.waitForEvent((e) => a.events.indexOf(e) >= eventsBeforeClose && e.type === 'presence' && e.username === ub && e.online === false);

      const now = Date.now();
      seedFakeConnection(region, stackRes, {
        connectionId: staleId,
        username: ub,
        connectedAt: now - 60_000,
        lastSeenAt: now,
      });
      const eventsBefore = a.events.length;
      const mid = randomUUID();
      a.sendRaw(JSON.stringify({ action: 'sendMessage', requestId: randomUUID(), conversationId: directId, messageId: mid, text: 'trigger-410-gone' }));
      await a.waitForEvent((e) => e.type === 'message' && e.messageId === mid);
      const offEv = await a.waitForEvent((e) => a.events.indexOf(e) >= eventsBefore && e.type === 'presence' && e.username === ub && e.online === false);
      assert(offEv.online === false, '410 Gone unbind must announce offline to contact A');
      const connItem = awsJson(region, [
        'dynamodb',
        'get-item',
        '--table-name',
        stackRes.connectionsTable,
        '--consistent-read',
        '--key',
        JSON.stringify({ connectionId: { S: staleId } }),
      ]).Item;
      assert(!connItem, 'Stale connection item must be removed from Connections after 410 Gone');
      return { staleRemoved: true, offlineVersion: offEv.version };
    });

    await runCase('S5-T7-SWEEPER', 'Expiração real por inatividade no presenceSweeper (>10 min) e anúncio offline (T7.2, RF07)', async () => {
      // Ensure A and C share a conversation (created in S4-T5-HISTORY), disconnect C, seed idle connection (>11 min)
      c.close();
      await a.waitForEvent((e) => e.type === 'presence' && e.username === uc && e.online === false);
      const idleId = `idle-sweep-${TAG}`;
      const now = Date.now();
      seedFakeConnection(region, stackRes, {
        connectionId: idleId,
        username: uc,
        connectedAt: now - 12 * 60_000,
        lastSeenAt: now - 11 * 60_000,
      });
      const checkSearch = await a.request('search', { query: uc });
      assert(checkSearch.type === 'response' && checkSearch.data.people.some((p) => p.username === uc && p.online === true), 'Seeded idle user must initially appear online');

      const eventsBefore = a.events.length;
      const sweptOff = await a.waitForEvent(
        (e) => a.events.indexOf(e) >= eventsBefore && e.type === 'presence' && e.username === uc && e.online === false,
        80_000,
      );
      const connItem = awsJson(region, [
        'dynamodb',
        'get-item',
        '--table-name',
        stackRes.connectionsTable,
        '--consistent-read',
        '--key',
        JSON.stringify({ connectionId: { S: idleId } }),
      ]).Item;
      assert(!connItem, 'Idle connection must be removed by presenceSweeper');
      return { idleRemoved: true, offlineVersion: sweptOff.version, sweeperLogGroup: stackRes.sweeperLogGroup };
    });

    await runCase('S6-SEC-1', 'Rejeição de conexões inválidas ($connect, incl. controle/bidi) e rotas desconhecidas / não-JSON ($default)', async () => {
      await expectHandshakeRejected('');
      await expectHandshakeRejected('username=a');
      await expectHandshakeRejected('username=invalido%20espaco');
      await expectHandshakeRejected(`username=ctrl_${TAG}&displayName=Ana%0ABia`);
      await expectHandshakeRejected(`username=bidi_${TAG}&displayName=Ana%E2%80%AEBia`);

      const badAction = await a.request('acaoInexistente', {});
      assert(badAction.type === 'error' && badAction.code === 'unknownAction', 'unknownAction expected on $default');

      a.sendRaw('{nao-e-json');
      const nonJson = await a.waitForEvent((e) => e.type === 'error' && e.code === 'unknownAction' && !e.requestId);
      assert(Boolean(nonJson), 'Non-JSON payload must return unknownAction from $default');
      return { handshakeCasesRejected: 5 };
    });
  } finally {
    a.close();
    b.close();
    c.close();
  }

  await runCase('S6-LOGS-1', 'Logs estruturados e anonimizados no CloudWatch (app e presenceSweeper, RNF03)', async () => {
    // Allow CloudWatch Logs ingestion lag (~4 s)
    await new Promise((r) => setTimeout(r, 4000));
    const logGroup = stackRes.appLogGroup;
    assert(Boolean(logGroup), 'app log group not found');

    const events = awsJson(region, [
      'logs',
      'filter-log-events',
      '--log-group-name',
      logGroup,
      '--start-time',
      String(startedAt - 10_000),
    ]).events;
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

    const sweeperEvents = stackRes.sweeperLogGroup
      ? awsJson(region, [
          'logs',
          'filter-log-events',
          '--log-group-name',
          stackRes.sweeperLogGroup,
          '--start-time',
          String(startedAt - 75_000),
        ]).events
      : [];
    const sweeperLog = sweeperEvents
      .map((e) => {
        const idx = e.message.indexOf('{"route":');
        if (idx < 0) return null;
        try { return JSON.parse(e.message.slice(idx)); } catch { return null; }
      })
      .find((l) => l && l.route === 'presenceSweeper');
    assert(Boolean(sweeperLog), 'Expected route=presenceSweeper structured log entry');

    return { logGroup, sweeperLogGroup: stackRes.sweeperLogGroup, structuredLines: jsonLines.length, sample, dupLog, forbLog, sweeperLog };
  });

  const report = buildReport({ endpoint: url, stage, region, sanitize, caseResults: results });
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Saved integration report to ${outPath}`);
  }
  console.log(`\nSummary: ${report.passed}/${report.total} passed`);
  if (report.passed !== report.total) process.exit(1);
}

async function runSelfTest() {
  assert(true, 'ok');
  let threw = false;
  try {
    assert(false, 'expected');
  } catch {
    threw = true;
  }
  assert(threw, 'assert(false) must throw');

  const parsed = parseCliArgs(['node', 'script', 'wss://example.com/dev', '--sanitize', '--out', 'r.json']);
  assert(parsed.sanitize && parsed.outPath === 'r.json' && parsed.region === 'sa-east-1', 'parseCliArgs failed');

  let badFlag = false;
  try {
    parseCliArgs(['node', 'script', 'wss://example.com/dev', '--out', '--sanitize']);
  } catch {
    badFlag = true;
  }
  assert(badFlag, 'parseCliArgs must reject flag without value');

  const rawResults = [{ id: 'S6-LOGS-1', status: 'PASS', detail: { logGroup: '/aws/lambda/HubWebSocket-dev-app-XYZ123' } }];
  const sanitized = buildReport({
    endpoint: 'wss://secret123.execute-api.sa-east-1.amazonaws.com/dev',
    stage: 'dev',
    region: 'sa-east-1',
    sanitize: true,
    caseResults: rawResults,
  });
  assert(sanitized.endpoint === 'wss://<api-id>.execute-api.sa-east-1.amazonaws.com/dev', 'endpoint not sanitized');
  assert(sanitized.results[0].detail.logGroup === 'HubWebSocket-dev-appLogs-<id>', 'logGroup not sanitized');
  assert(rawResults[0].detail.logGroup === '/aws/lambda/HubWebSocket-dev-app-XYZ123', 'raw results mutated');

  const cli = new TestClient('qa_self');
  const waitP = cli.waitForEvent(() => false, 5_000);
  cli.close();
  let waitRejected = false;
  try {
    await waitP;
  } catch {
    waitRejected = true;
  }
  assert(waitRejected && cli.eventWaiters.length === 0, 'close() must clear waiters');
  console.log('Self-test passed');
}

const opts = parseCliArgs(process.argv);
if (opts.selfTest) {
  runSelfTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main(opts).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
