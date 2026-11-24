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

  it('clears a pending sendMessage and its 15 s timer when the confirming message arrives', async () => {
    vi.useFakeTimers();
    const { hub, socket } = await connected();
    const events: unknown[] = [];
    hub.events.subscribe((e) => events.push(e));

    const sending = hub.request('sendMessage', {
      conversationId: 'd:bruno:marina',
      messageId: 'm-1',
      text: 'oi',
    });

    // Another sender reusing the same messageId must not clear our pending request.
    socket.receive({
      type: 'message',
      conversationId: 'd:bruno:marina',
      sk: 'm#0000000001000#bruno#m-1',
      messageId: 'm-1',
      sender: 'bruno',
      text: 'oi',
      sentAt: 1000,
    });
    // Our own confirming message resolves the pending send and clears its timeout.
    socket.receive({
      type: 'message',
      conversationId: 'd:bruno:marina',
      sk: 'm#0000000002000#marina#m-1',
      messageId: 'm-1',
      sender: 'marina',
      text: 'oi',
      sentAt: 2000,
    });

    await expect(sending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(events).toHaveLength(2);
  });

  it('handles error events with messageId even when requestId is absent', async () => {
    const { hub, socket } = await connected();
    const events: unknown[] = [];
    hub.events.subscribe((e) => events.push(e));

    const sending = hub.request('sendMessage', {
      conversationId: 'd:bruno:marina',
      messageId: 'm-1',
      text: 'oi',
    });
    socket.receive({
      type: 'error',
      messageId: 'm-1',
      code: 'invalidRequest',
      message: 'too large',
    });
    expect((await failure(sending)).reason).toEqual({
      code: 'invalidRequest',
      message: 'too large',
    });

    // When no matching pending request exists, forwards the message error to events.
    socket.receive({
      type: 'error',
      messageId: 'm-late',
      code: 'forbidden',
      message: 'not a member',
    });
    expect(events).toEqual([
      {
        type: 'error',
        messageId: 'm-late',
        code: 'forbidden',
        message: 'not a member',
      },
    ]);
  });

  it('probes with an immediate heartbeat on checkConnection and drops if pong misses', async () => {
    vi.useFakeTimers();
    const { hub, socket } = await connected();
    const dropped = vi.fn();
    hub.dropped.subscribe(dropped);

    hub.checkConnection();
    expect(socket.last()).toMatchObject({ action: 'heartbeat' });

    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS);
    expect(hub.status()).toBe('lost');
    expect(dropped).toHaveBeenCalledOnce();
  });

  it('switches to a parallel socket on open and drains pending requests on the old one', async () => {
    const { hub, socket: first, sockets } = await connected();
    const dropped = vi.fn();
    hub.dropped.subscribe(dropped);

    const pendingReq = hub.request<{ ok: boolean }>('search', { query: 'bru' });
    const switching = hub.reconnectInParallel('marina', 'Marina Nova');
    const second = sockets[1]!;

    expect(new URL(second.url).searchParams.get('displayName')).toBe('Marina Nova');
    expect(first.closed).toBe(false);
    expect(hub.status()).toBe('open');

    second.open();
    await expect(switching).resolves.toBeUndefined();
    // Old socket stays open while its pending request is still waiting.
    expect(first.closed).toBe(false);
    expect(hub.status()).toBe('open');
    expect(dropped).not.toHaveBeenCalled();

    // New requests go through the new active socket.
    const nextReq = hub.request<{ ok: boolean }>('search', { query: 'ana' });
    expect(second.last()).toMatchObject({ action: 'search', query: 'ana' });

    // Once the pending request on the old socket answers, the old socket closes immediately.
    first.receive({
      type: 'response',
      requestId: first.last().requestId,
      data: { ok: true },
    });
    await expect(pendingReq).resolves.toEqual({ ok: true });
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(dropped).not.toHaveBeenCalled();

    second.receive({
      type: 'response',
      requestId: second.last().requestId,
      data: { ok: true },
    });
    await expect(nextReq).resolves.toEqual({ ok: true });
  });

  it('closes the old socket immediately on parallel switch when nothing is pending', async () => {
    const { hub, socket: first, sockets } = await connected();
    const switching = hub.reconnectInParallel('marina', 'Marina Nova');
    sockets[1]!.open();
    await expect(switching).resolves.toBeUndefined();
    expect(first.closed).toBe(true);
    expect(hub.status()).toBe('open');
  });

  it('keeps the active connection open if the parallel replacement fails to open', async () => {
    const { hub, socket: first, sockets } = await connected();
    const dropped = vi.fn();
    hub.dropped.subscribe(dropped);

    const switching = hub.reconnectInParallel('marina', 'Marina Nova');
    sockets[1]!.drop();

    await expect(switching).rejects.toThrow();
    expect(first.closed).toBe(false);
    expect(hub.status()).toBe('open');
    expect(dropped).not.toHaveBeenCalled();
  });
});
