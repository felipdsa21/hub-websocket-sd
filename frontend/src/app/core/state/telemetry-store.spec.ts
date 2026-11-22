import { TestBed } from '@angular/core/testing';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { HEARTBEAT_INTERVAL_MS } from '@/core/hub/hub-socket';
import {
  ALICE_BRUNO,
  FakeWebSocket,
  aliceBrunoChat,
  enterAsAlice,
  provideFakeSockets,
  useTestBackend,
} from '@/core/hub/testing';
import { messageSk } from '@/core/model/message';
import { MessagesStore } from './messages-store';
import { SessionStore } from './session-store';
import { TelemetryStore } from './telemetry-store';

describe('TelemetryStore', () => {
  afterEach(() => vi.useRealTimers());

  it('records heartbeat and message RTT samples and computes the average', async () => {
    localStorage.clear();
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [...provideTestFixtures(), ...provideFakeSockets(sockets)],
    });
    useTestBackend();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const session = TestBed.inject(SessionStore);
    const telemetry = TestBed.inject(TelemetryStore);
    const messages = TestBed.inject(MessagesStore);

    vi.useFakeTimers();
    const entering = session.enter('alice', 'Alice');
    const socket = sockets[0]!;
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    socket.receive({
      type: 'response',
      requestId: socket.last().requestId,
      data: { serverTime: 1000, updated: [], conversations: [aliceBrunoChat()] },
    });
    await entering;

    // Heartbeat RTT
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    const hbReq = socket.last();
    expect(hbReq['action']).toBe('heartbeat');
    await vi.advanceTimersByTimeAsync(40);
    socket.receive({ type: 'pong', requestId: hbReq.requestId });
    await vi.advanceTimersByTimeAsync(0);
    expect(telemetry.lastRttMs()).toBe(40);

    // Message confirmation RTT
    const id = '00000000-0000-4000-8000-000000000009';
    messages.send(ALICE_BRUNO, 'oi', id);
    await vi.advanceTimersByTimeAsync(80);
    socket.receive({
      type: 'message',
      conversationId: ALICE_BRUNO,
      sk: messageSk(2000, 'alice', id),
      messageId: id,
      sender: 'alice',
      text: 'oi',
      sentAt: 2000,
    });
    expect(telemetry.lastRttMs()).toBe(80);
    expect(telemetry.averageRttMs()).toBe(60);
    expect(telemetry.events().length).toBeGreaterThanOrEqual(2);

    telemetry.clear();
    expect(telemetry.events()).toEqual([]);
    expect(telemetry.lastRttMs()).toBeNull();
  });

  it('records presence events from the backend', async () => {
    localStorage.clear();
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [...provideTestFixtures(), ...provideFakeSockets(sockets)],
    });
    useTestBackend();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const session = TestBed.inject(SessionStore);
    const telemetry = TestBed.inject(TelemetryStore);
    const socket = await enterAsAlice((u, d) => session.enter(u, d), sockets);

    socket.receive({
      type: 'presence',
      username: 'bruno',
      displayName: 'Bruno',
      online: false,
      version: 8,
    });
    expect(telemetry.events()[0]).toMatchObject({
      kind: 'presence',
      summary: '@bruno offline (v8)',
    });
  });

  it('resets events, RTT samples and showLatency when leaving the session', async () => {
    localStorage.clear();
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [...provideTestFixtures(), ...provideFakeSockets(sockets)],
    });
    useTestBackend();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const session = TestBed.inject(SessionStore);
    const telemetry = TestBed.inject(TelemetryStore);
    await enterAsAlice((u, d) => session.enter(u, d), sockets);

    telemetry.showLatency.set(true);
    telemetry.recordRtt(35, 'heartbeat');
    expect(telemetry.events()).toHaveLength(1);
    expect(telemetry.lastRttMs()).toBe(35);

    session.leave();
    expect(telemetry.events()).toEqual([]);
    expect(telemetry.lastRttMs()).toBeNull();
    expect(telemetry.averageRttMs()).toBeNull();
    expect(telemetry.showLatency()).toBe(false);
  });

  it('drops in-flight RTT tracking when a message is discarded or confirmed by reconnect sync', async () => {
    localStorage.clear();
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [...provideTestFixtures(), ...provideFakeSockets(sockets)],
    });
    useTestBackend();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const session = TestBed.inject(SessionStore);
    const telemetry = TestBed.inject(TelemetryStore);
    const messages = TestBed.inject(MessagesStore);

    vi.useFakeTimers();
    const entering = session.enter('alice', 'Alice');
    const socket = sockets[0]!;
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    socket.receive({
      type: 'response',
      requestId: socket.last().requestId,
      data: { serverTime: 1000, updated: [], conversations: [aliceBrunoChat()] },
    });
    await entering;

    // 1. Discarded while in flight: late message confirmation must not record RTT.
    const discardedId = '00000000-0000-4000-8000-000000000010';
    messages.send(ALICE_BRUNO, 'descartar', discardedId);
    await vi.advanceTimersByTimeAsync(50);
    messages.discard(discardedId);
    socket.receive({
      type: 'message',
      conversationId: ALICE_BRUNO,
      sk: messageSk(2000, 'alice', discardedId),
      messageId: discardedId,
      sender: 'alice',
      text: 'descartar',
      sentAt: 2000,
    });
    expect(telemetry.lastRttMs()).toBeNull();

    // 2. Confirmed via reconnect history catch-up: offline downtime must not record RTT.
    messages.open(ALICE_BRUNO);
    socket.receive({
      type: 'response',
      requestId: socket.last().requestId,
      data: { messages: [], hasMore: false },
    });
    await vi.advanceTimersByTimeAsync(0);

    const syncedId = '00000000-0000-4000-8000-000000000011';
    messages.send(ALICE_BRUNO, 'offline', syncedId);
    await vi.advanceTimersByTimeAsync(250);
    socket.drop();
    const reconnected = sockets[1]!;
    reconnected.open();
    await vi.advanceTimersByTimeAsync(0);
    reconnected.receive({
      type: 'response',
      requestId: reconnected.last().requestId,
      data: { serverTime: 3000, updated: [ALICE_BRUNO], conversations: [aliceBrunoChat()] },
    });
    await vi.advanceTimersByTimeAsync(0);
    const getHistoryReq = reconnected.sent.find((r) => r['action'] === 'getHistory')!;
    reconnected.receive({
      type: 'response',
      requestId: getHistoryReq['requestId'] as string,
      data: {
        messages: [
          {
            conversationId: ALICE_BRUNO,
            sk: messageSk(3000, 'alice', syncedId),
            messageId: syncedId,
            sender: 'alice',
            text: 'offline',
            sentAt: 3000,
          },
        ],
        hasMore: false,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(messages.pendingCount()).toBe(0);
    expect(telemetry.lastRttMs()).toBeNull();
  });
});
