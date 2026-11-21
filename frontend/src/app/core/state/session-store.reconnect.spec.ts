import { TestBed } from '@angular/core/testing';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { REQUEST_TIMEOUT_MS } from '@/core/hub/hub-socket';
import {
  ALICE_BRUNO,
  BRUNO,
  FakeWebSocket,
  aliceBrunoChat,
  answer,
  provideFakeSockets,
  useTestBackend,
} from '@/core/hub/testing';
import { Message, messageSk, skBeforeInstant } from '@/core/model/message';
import { ConnectionStore, LOSS_INDICATION_MS } from './connection-store';
import { MessagesStore, SYNC_OVERLAP_MS } from './messages-store';
import { RECONNECT_INITIAL_DELAY_MS, RECONNECT_MAX_DELAY_MS, SessionStore } from './session-store';

function message(sender: string, sentAt: number, messageId: string, text = 'oi'): Message {
  return {
    conversationId: ALICE_BRUNO,
    sk: messageSk(sentAt, sender, messageId),
    messageId,
    sender,
    text,
    sentAt,
  };
}

async function setUp(conversations?: unknown[], serverTime = 100_000) {
  localStorage.clear();
  const sockets: FakeWebSocket[] = [];
  TestBed.configureTestingModule({
    providers: [...provideTestFixtures(), ...provideFakeSockets(sockets)],
  });
  useTestBackend();
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const session = TestBed.inject(SessionStore);
  const entering = session.enter('alice', 'Alice');
  const socket = sockets[0]!;
  socket.open();
  await Promise.resolve();
  answer(socket, {
    serverTime,
    updated: [],
    conversations: conversations ?? [aliceBrunoChat()],
  });
  await entering;
  return {
    sockets,
    socket,
    info,
    session,
    connection: TestBed.inject(ConnectionStore),
    messages: TestBed.inject(MessagesStore),
  };
}

describe('SessionStore reconnection and retry queue (RF08, RF12)', () => {
  afterEach(() => vi.useRealTimers());

  it('reconnects at once on a short drop without indicating loss, sending sync with since', async () => {
    const { sockets, socket, info, connection } = await setUp([aliceBrunoChat()], 100_000);
    vi.useFakeTimers();
    const reconnected = vi.fn();
    connection.reconnected.subscribe(reconnected);

    socket.drop();
    expect(connection.connected()).toBe(false);
    expect(connection.lossIndicated()).toBe(false);
    expect(connection.presenceVisible()).toBe(true);

    // First attempt is immediate (0 ms) and logged to the console.
    expect(sockets).toHaveLength(2);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('delay 0 ms'));

    const next = sockets[1]!;
    next.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(next.last()).toEqual(
      expect.objectContaining({ action: 'sync', since: 100_000 - SYNC_OVERLAP_MS }),
    );
    // Still disabled until `sync` answers.
    expect(connection.connected()).toBe(false);

    answer(next, { serverTime: 101_000, updated: [], conversations: [aliceBrunoChat()] });
    await vi.advanceTimersByTimeAsync(0);

    expect(connection.connected()).toBe(true);
    expect(connection.lossIndicated()).toBe(false);
    expect(reconnected).not.toHaveBeenCalled();
  });

  it('indicates loss after 3 s, backs off exponentially up to 30 s, and signals recovery', async () => {
    const { sockets, socket, info, connection } = await setUp();
    vi.useFakeTimers();
    const reconnected = vi.fn();
    connection.reconnected.subscribe(reconnected);

    socket.drop();
    // Attempt 1 (immediate) fails.
    sockets[1]!.drop();
    await vi.advanceTimersByTimeAsync(0);

    // Attempt 2 waits 1 s.
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_DELAY_MS - 1);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    sockets[2]!.drop();
    await vi.advanceTimersByTimeAsync(0);

    // Attempt 3 waits 2 s; 3 s total elapsed => loss is indicated and presence hidden.
    await vi.advanceTimersByTimeAsync(LOSS_INDICATION_MS - RECONNECT_INITIAL_DELAY_MS);
    expect(connection.lossIndicated()).toBe(true);
    expect(connection.presenceVisible()).toBe(false);
    expect(sockets).toHaveLength(4);

    // Keep failing until the 30 s cap is reached (4 s, 8 s, 16 s, 30 s).
    for (const delay of [4_000, 8_000, 16_000, RECONNECT_MAX_DELAY_MS]) {
      sockets.at(-1)!.drop();
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(`delay ${RECONNECT_MAX_DELAY_MS} ms`),
    );

    const recovered = sockets.at(-1)!;
    recovered.open();
    await vi.advanceTimersByTimeAsync(0);
    answer(recovered, { serverTime: 200_000, updated: [], conversations: [aliceBrunoChat()] });
    await vi.advanceTimersByTimeAsync(0);

    expect(connection.connected()).toBe(true);
    expect(connection.lossIndicated()).toBe(false);
    expect(connection.presenceVisible()).toBe(true);
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it('retries sync once after 15 s without answer and reconnects if the second fails too', async () => {
    const { sockets, socket, connection } = await setUp();
    vi.useFakeTimers();

    socket.drop();
    const second = sockets[1]!;
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.sent.filter((r) => r['action'] === 'sync')).toHaveLength(1);

    // First sync times out after 15 s -> retried on the same open socket.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(second.sent.filter((r) => r['action'] === 'sync')).toHaveLength(2);

    // Second sync also times out -> closes socket and reconnects after 1 s backoff.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(second.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_DELAY_MS);
    expect(sockets).toHaveLength(3);

    const third = sockets[2]!;
    third.open();
    await vi.advanceTimersByTimeAsync(0);
    answer(third, { serverTime: 200_000, updated: [], conversations: [aliceBrunoChat()] });
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.connected()).toBe(true);
  });

  it('catches up loaded conversations listed in updated using after shifted back 30 s', async () => {
    const { sockets, socket, messages } = await setUp([aliceBrunoChat()], 100_000);
    // Load initial history for ALICE_BRUNO.
    messages.open(ALICE_BRUNO);
    const m1 = message('bruno', 90_000, 'm1', 'antes');
    answer(socket, { messages: [m1], hasMore: false });
    await new Promise((r) => setTimeout(r));

    vi.useFakeTimers();
    socket.drop();
    const next = sockets[1]!;
    next.open();
    await vi.advanceTimersByTimeAsync(0);
    answer(next, {
      serverTime: 120_000,
      updated: [ALICE_BRUNO, 'g:not-loaded'],
      conversations: [aliceBrunoChat({ lastMessageAt: 115_000, lastMessageBy: 'bruno' })],
    });
    await vi.advanceTimersByTimeAsync(0);

    // Only ALICE_BRUNO had loaded history; g:not-loaded is skipped until opened.
    const historyRequests = next.sent.filter((r) => r['action'] === 'getHistory');
    expect(historyRequests).toHaveLength(1);
    expect(historyRequests[0]).toMatchObject({
      conversationId: ALICE_BRUNO,
      after: skBeforeInstant(90_000 - SYNC_OVERLAP_MS),
    });

    const m2 = message('bruno', 110_000, 'm2', 'durante-1');
    const m3 = message('bruno', 115_000, 'm3', 'durante-2');
    answer(next, { messages: [m1, m2], hasMore: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(next.last()).toMatchObject({
      action: 'getHistory',
      conversationId: ALICE_BRUNO,
      after: m2.sk,
    });
    answer(next, { messages: [m3], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(messages.history(ALICE_BRUNO)?.messages).toEqual([m1, m2, m3]);
  });

  it('resends queued messages in order on reconnection and warns on beforeunload', async () => {
    const { sockets, socket, info, messages } = await setUp();
    vi.useFakeTimers();

    const id1 = '00000000-0000-4000-8000-000000000001';
    const id2 = '00000000-0000-4000-8000-000000000002';

    socket.drop();
    messages.send(ALICE_BRUNO, 'primeira', id1);
    messages.send(ALICE_BRUNO, 'segunda', id2);
    expect(messages.pendingCount()).toBe(2);

    // Reload/close warning while pending (RF12, section 4.6).
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    const next = sockets[1]!;
    next.open();
    await vi.advanceTimersByTimeAsync(0);
    answer(next, { serverTime: 105_000, updated: [], conversations: [aliceBrunoChat()] });
    await vi.advanceTimersByTimeAsync(0);

    // Only the first pending message is sent until it is confirmed.
    const sends = () => next.sent.filter((r) => r['action'] === 'sendMessage');
    expect(sends().map((r) => r['messageId'])).toEqual([id1]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining(id1));

    next.receive({ type: 'message', ...message('alice', 105_100, id1, 'primeira') });
    expect(sends().map((r) => r['messageId'])).toEqual([id1, id2]);

    next.receive({ type: 'message', ...message('alice', 105_200, id2, 'segunda') });
    expect(messages.pendingCount()).toBe(0);

    const unloadAfter = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadAfter);
    expect(unloadAfter.defaultPrevented).toBe(false);
  });

  it('stops reconnecting when the user leaves', async () => {
    const { sockets, socket, session, connection } = await setUp([
      aliceBrunoChat({ members: [BRUNO] }),
    ]);
    vi.useFakeTimers();

    socket.drop();
    sockets[1]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    session.leave();

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 2);
    expect(sockets).toHaveLength(2);
    expect(connection.lossIndicated()).toBe(false);
  });

  it('computes catch-up after before applying messages held during reconnect sync', async () => {
    const { sockets, socket, messages } = await setUp([aliceBrunoChat()], 100_000);
    messages.open(ALICE_BRUNO);
    const m1 = message('bruno', 80_000, 'm1', 'antes');
    answer(socket, { messages: [m1], hasMore: false });
    await new Promise((r) => setTimeout(r));

    vi.useFakeTimers();
    socket.drop();
    const next = sockets[1]!;
    next.open();
    await vi.advanceTimersByTimeAsync(0);

    // A live message sent > 30 s later arrives while `sync` is in flight and is held.
    const m2 = message('bruno', 85_000, 'm2', 'durante');
    const m3 = message('bruno', 130_000, 'm3', 'ao-vivo');
    next.receive({ type: 'message', ...m3 });
    answer(next, {
      serverTime: 130_000,
      updated: [ALICE_BRUNO],
      conversations: [aliceBrunoChat({ lastMessageAt: 130_000, lastMessageBy: 'bruno' })],
    });
    await vi.advanceTimersByTimeAsync(0);

    // `after` must still come from m1 (80_000 - 30_000), not m3 (130_000 - 30_000).
    expect(next.sent.find((r) => r['action'] === 'getHistory')).toMatchObject({
      conversationId: ALICE_BRUNO,
      after: skBeforeInstant(80_000 - SYNC_OVERLAP_MS),
    });

    answer(next, { messages: [m1, m2, m3], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.history(ALICE_BRUNO)?.messages).toEqual([m1, m2, m3]);
  });

  it('retries an interrupted history catch-up on the next reconnection', async () => {
    const { sockets, socket, messages } = await setUp([aliceBrunoChat()], 100_000);
    messages.open(ALICE_BRUNO);
    const m1 = message('bruno', 80_000, 'm1', 'antes');
    answer(socket, { messages: [m1], hasMore: false });
    await new Promise((r) => setTimeout(r));

    vi.useFakeTimers();
    socket.drop();
    const second = sockets[1]!;
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    answer(second, {
      serverTime: 150_000,
      updated: [ALICE_BRUNO],
      conversations: [aliceBrunoChat({ lastMessageAt: 90_000, lastMessageBy: 'bruno' })],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.sent.filter((r) => r['action'] === 'getHistory')).toHaveLength(1);

    // Connection drops before `getHistory` answers.
    second.drop();
    await vi.advanceTimersByTimeAsync(0);
    const third = sockets[2]!;
    third.open();
    await vi.advanceTimersByTimeAsync(0);

    // Next sync no longer includes ALICE_BRUNO in `updated`, yet catch-up retries.
    answer(third, {
      serverTime: 160_000,
      updated: [],
      conversations: [aliceBrunoChat({ lastMessageAt: 90_000, lastMessageBy: 'bruno' })],
    });
    await vi.advanceTimersByTimeAsync(0);

    const retry = third.sent.find((r) => r['action'] === 'getHistory');
    expect(retry).toMatchObject({
      conversationId: ALICE_BRUNO,
      after: skBeforeInstant(80_000 - SYNC_OVERLAP_MS),
    });

    const m2 = message('bruno', 90_000, 'm2', 'perdida');
    answer(third, { messages: [m1, m2], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.history(ALICE_BRUNO)?.messages).toEqual([m1, m2]);
  });
});
