import { TestBed } from '@angular/core/testing';
import {
  HEARTBEAT_INTERVAL_MS,
  HubSocket,
  PONG_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  RequestFailure,
} from './hub-socket';
import { FakeWebSocket, TEST_WEBSOCKET_URL, provideFakeSockets, useTestBackend } from './testing';

function setUp() {
  const sockets: FakeWebSocket[] = [];
  TestBed.configureTestingModule({ providers: provideFakeSockets(sockets) });
  useTestBackend();
  const hub = TestBed.inject(HubSocket);
  return { hub, sockets };
}

async function connected() {
  const { hub, sockets } = setUp();
  const opening = hub.connect('marina', 'Marina Alves');
  const socket = sockets[0]!;
  socket.open();
  await opening;
  return { hub, socket, sockets };
}

async function failure(promise: Promise<unknown>): Promise<RequestFailure> {
  try {
    await promise;
  } catch (error) {
    return error as RequestFailure;
  }
  throw new Error('The request did not fail.');
}

describe('HubSocket', () => {
  afterEach(() => vi.useRealTimers());

  it('connects with the username and display name in the query string', async () => {
    const { hub, socket } = await connected();
    const url = new URL(socket.url);
    expect(`${url.origin}${url.pathname}`).toBe(TEST_WEBSOCKET_URL);
    expect(url.searchParams.get('username')).toBe('marina');
    expect(url.searchParams.get('displayName')).toBe('Marina Alves');
    expect(hub.status()).toBe('open');
  });

  it('leaves the display name out when there is none', () => {
    const { hub, sockets } = setUp();
    void hub.connect('marina').catch(() => undefined);
    expect(new URL(sockets[0]!.url).searchParams.has('displayName')).toBe(false);
  });

  it('fails to connect when the connection closes before opening', async () => {
    const { hub, sockets } = setUp();
    const opening = hub.connect('marina');
    sockets[0]!.drop();
    await expect(opening).rejects.toThrow();
    expect(hub.status()).toBe('closed');
  });

  it('matches the response to its request by the requestId', async () => {
    const { hub, socket } = await connected();
    const sync = hub.request<{ serverTime: number }>('sync', { since: 5 });

    const sent = socket.last();
    expect(sent).toMatchObject({ action: 'sync', since: 5 });
    expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
    socket.receive({ type: 'response', requestId: 'other', data: { serverTime: 1 } });
    socket.receive({ type: 'response', requestId: sent.requestId, data: { serverTime: 2 } });

    await expect(sync).resolves.toEqual({ serverTime: 2 });
  });

  it('rejects with the error event that refuses the request', async () => {
    const { hub, socket } = await connected();
    const open = hub.request('openDirect', { username: 'ninguem' });
    socket.receive({
      type: 'error',
      requestId: socket.last().requestId,
      code: 'notFound',
      message: 'User not found.',
      details: { usernames: ['ninguem'] },
    });

    expect((await failure(open)).reason).toEqual({
      code: 'notFound',
      message: 'User not found.',
      details: { usernames: ['ninguem'] },
    });
  });

  it('gives a request without an answer in 15 s as noResponse and ignores a late answer', async () => {
    vi.useFakeTimers();
    const { hub, socket } = await connected();
    const events: unknown[] = [];
    hub.events.subscribe((e) => events.push(e));
    const search = hub.request('search', { query: 'bru' });
    const { requestId } = socket.last();

    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    socket.receive({ type: 'response', requestId, data: {} });

    expect((await failure(search)).reason).toBe('noResponse');
    expect(events).toEqual([]);
  });

  it('passes the other events on, and logs a message without type', async () => {
    const { hub, socket } = await connected();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events: unknown[] = [];
    hub.events.subscribe((e) => events.push(e));

    socket.receive({ type: 'conversationRemoved', conversationId: 'g:1' });
    socket.receive({ message: 'Internal server error' });

    expect(events).toEqual([{ type: 'conversationRemoved', conversationId: 'g:1' }]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('sends heartbeat every 30 s and stays open while pong arrives', async () => {
    vi.useFakeTimers();
    const { hub, socket } = await connected();

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(socket.last()).toMatchObject({ action: 'heartbeat' });
    socket.receive({ type: 'pong', requestId: socket.last().requestId });
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS);

    expect(hub.status()).toBe('open');
    expect(socket.closed).toBe(false);
  });

  it('takes the connection as lost without pong in 10 s', async () => {
    vi.useFakeTimers();
    const { hub, socket } = await connected();

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS);

    expect(hub.status()).toBe('lost');
    expect(socket.closed).toBe(true);
  });

  it('marks a dropped connection as lost and fails the requests still waiting', async () => {
    const { hub, socket } = await connected();
    const sync = hub.request('sync');

    socket.drop();

    expect(hub.status()).toBe('lost');
    expect((await failure(sync)).reason).toBe('noResponse');
  });

  it("doesn't count a close on request as lost", async () => {
    const { hub, socket } = await connected();
    hub.close();
    expect(hub.status()).toBe('closed');
    expect(socket.closed).toBe(true);
    expect((await failure(hub.request('sync'))).reason).toBe('noResponse');
  });

  it('fails a connect() that another one replaces before it opens', async () => {
    const { hub, sockets } = setUp();
    const first = hub.connect('marina');
    const second = hub.connect('marina', 'Marina A.');

    await expect(first).rejects.toThrow();
    expect(sockets[0]!.closed).toBe(true);
    sockets[1]!.open();
    await expect(second).resolves.toBeUndefined();
    expect(hub.status()).toBe('open');
  });

  it('fails a connect() closed on request before it opens', async () => {
    const { hub } = setUp();
    const opening = hub.connect('marina');
    hub.close();
    await expect(opening).rejects.toThrow();
    expect(hub.status()).toBe('closed');
  });
});
