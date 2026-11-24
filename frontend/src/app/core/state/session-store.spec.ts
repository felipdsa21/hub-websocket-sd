import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { DEV_MODE, HubConfig } from '@/core/hub/hub-config';
import { FakeWebSocket, answer, provideFakeSockets, useTestBackend } from '@/core/hub/testing';
import { provideTestClock } from '@/core/time/testing';
import { ConnectionStore } from './connection-store';
import { ConversationsStore } from './conversations-store';
import { MessagesStore } from './messages-store';
import { RECONNECT_INITIAL_DELAY_MS, SessionStore } from './session-store';
import { CURRENT_USER_STORAGE_KEY, userStorageKey } from './user-storage';
import { UsersStore } from './users-store';

describe('SessionStore', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  function setUp() {
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [provideRouter([]), ...provideTestClock(), ...provideFakeSockets(sockets)],
    });
    useTestBackend();
    return { session: TestBed.inject(SessionStore), sockets };
  }

  const alice = { username: 'alice', displayName: 'Alice', online: true, version: 3 };
  const bruno = { username: 'bruno', displayName: 'Bruno', online: false, version: 7 };

  it('connects, loads the list with sync and only then enters', async () => {
    const { session, sockets } = setUp();
    const entering = session.enter('Alice', ' Alice ');
    expect(session.enterStatus()).toBe('connecting');

    const socket = sockets[0]!;
    socket.open();
    await Promise.resolve();
    expect(socket.last()).toMatchObject({ action: 'sync' });
    expect(session.user()).toBeNull();
    socket.receive({
      type: 'response',
      requestId: socket.last().requestId,
      data: {
        serverTime: 1000,
        updated: [],
        conversations: [
          {
            conversationId: 'd:alice:bruno',
            type: 'direct',
            members: [alice, bruno],
            lastMessageAt: 900,
            lastMessageBy: 'bruno',
            joinedAt: 100,
          },
          { conversationId: 'g:1', type: 'group', name: 'SD', members: [alice], joinedAt: 200 },
        ],
      },
    });
    await entering;

    expect(session.user()).toEqual({ username: 'alice', displayName: 'Alice' });
    expect(session.enterStatus()).toBe('idle');
    const conversations = TestBed.inject(ConversationsStore);
    expect(conversations.sorted().map((c) => c.conversationId)).toEqual(['g:1', 'd:alice:bruno']);
    expect(conversations.get('d:alice:bruno')?.members).toEqual(['alice', 'bruno']);
    expect(TestBed.inject(UsersStore).get('bruno')).toEqual(bruno);
  });

  it('uses the username as the display name when it is blank, also without conversations', async () => {
    const { session, sockets } = setUp();
    const entering = session.enter('alice', '   ');
    const socket = sockets[0]!;
    socket.open();
    await Promise.resolve();
    socket.receive({
      type: 'response',
      requestId: socket.last().requestId,
      data: { serverTime: 1000, updated: [], conversations: [] },
    });
    await entering;

    expect(new URL(socket.url).searchParams.has('displayName')).toBe(false);
    expect(session.user()?.displayName).toBe('alice');
    expect(TestBed.inject(UsersStore).get('alice')).toMatchObject({ displayName: 'alice' });
  });

  it('shows a failure to enter when the connection is refused', async () => {
    const { session, sockets } = setUp();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const entering = session.enter('alice', '');
    sockets[0]!.drop();
    await entering;

    expect(session.enterStatus()).toBe('failed');
    expect(session.user()).toBeNull();
  });

  it('closes the connection when leaving', async () => {
    const { session, sockets } = setUp();
    const entering = session.enter('alice', '');
    const socket = sockets[0]!;
    socket.open();
    await Promise.resolve();
    socket.receive({
      type: 'response',
      requestId: socket.last().requestId,
      data: { serverTime: 1000, updated: [], conversations: [] },
    });
    await entering;

    session.leave();

    expect(socket.closed).toBe(true);
    expect(session.user()).toBeNull();
  });

  async function enterWith(conversations: unknown[]) {
    const { session, sockets } = setUp();
    const entering = session.enter('alice', 'Alice');
    const socket = sockets[0]!;
    socket.open();
    await Promise.resolve();
    socket.receive({
      type: 'response',
      requestId: socket.last().requestId,
      data: { serverTime: 1000, updated: [], conversations },
    });
    await entering;
    return session;
  }

  const fromBruno = {
    conversationId: 'd:alice:bruno',
    type: 'direct',
    members: [alice, bruno],
    lastMessageAt: 900,
    lastMessageBy: 'bruno',
    joinedAt: 100,
  };

  it('keeps the last message seen in each conversation across entries (RF10)', async () => {
    await enterWith([fromBruno]);
    const conversations = TestBed.inject(ConversationsStore);
    expect(conversations.withNewActivity().has('d:alice:bruno')).toBe(true);

    conversations.open('d:alice:bruno');
    expect(JSON.parse(localStorage.getItem(userStorageKey('alice'))!)).toEqual({
      displayName: 'Alice',
      seen: { 'd:alice:bruno': 900 },
    });

    TestBed.resetTestingModule();
    await enterWith([fromBruno]);
    expect(TestBed.inject(ConversationsStore).withNewActivity().size).toBe(0);
  });

  it('marks the conversation again when a newer message arrived since', async () => {
    localStorage.setItem(
      userStorageKey('alice'),
      JSON.stringify({ seen: { 'd:alice:bruno': 800 } }),
    );
    await enterWith([fromBruno]);
    expect(TestBed.inject(ConversationsStore).withNewActivity().has('d:alice:bruno')).toBe(true);
  });

  it('fails to enter, without connecting, when the published build has no valid address', async () => {
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [
        ...provideTestClock(),
        ...provideFakeSockets(sockets),
        { provide: DEV_MODE, useValue: false },
      ],
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const config = TestBed.inject(HubConfig);
    config.use({ websocketUrl: 'wss://hub.example/dev' });
    config.use({ websocketUrl: 'ws://hub.example/dev' });
    const session = TestBed.inject(SessionStore);

    await session.enter('alice', '');

    expect(session.enterStatus()).toBe('failed');
    expect(sockets).toEqual([]);
  });

  it('changes displayName via parallel socket without drop, preserving version and deduplicating notices (RF01)', async () => {
    const group = {
      conversationId: 'g:1',
      type: 'group',
      name: 'SD',
      members: [alice, bruno],
      joinedAt: 200,
    };
    const { session, sockets } = setUp();
    const entering = session.enter('alice', 'Alice');
    sockets[0]!.open();
    await Promise.resolve();
    answer(sockets[0]!, { serverTime: 1000, updated: [], conversations: [group] });
    await entering;

    const first = sockets[0]!;
    const connection = TestBed.inject(ConnectionStore);
    const users = TestBed.inject(UsersStore);
    const messages = TestBed.inject(MessagesStore);
    // Keep a pending request on the first socket so both connections overlap while draining.
    const pendingSearch = first.sent.length;
    messages.open('g:1');
    expect(first.sent.length).toBe(pendingSearch + 1);

    const changing = session.changeDisplayName('  Alice Nova  ');
    const second = sockets[1]!;
    expect(new URL(second.url).searchParams.get('displayName')).toBe('Alice Nova');
    expect(connection.connected()).toBe(true);
    expect(connection.lossIndicated()).toBe(false);
    expect(connection.presenceVisible()).toBe(true);

    second.open();
    await expect(changing).resolves.toBe(true);

    // Persisted in UserStorage, updated locally without bumping `version` so server presence wins.
    expect(JSON.parse(localStorage.getItem(userStorageKey('alice'))!)).toMatchObject({
      displayName: 'Alice Nova',
    });
    expect(session.user()?.displayName).toBe('Alice Nova');
    expect(users.get('alice')).toMatchObject({ displayName: 'Alice Nova', version: alice.version });
    expect(connection.connected()).toBe(true);
    expect(connection.lossIndicated()).toBe(false);
    expect(connection.presenceVisible()).toBe(true);
    expect(first.closed).toBe(false);

    // Server presence at version + 1 is accepted (not discarded by a local bump).
    second.receive({
      type: 'presence',
      username: 'alice',
      displayName: 'Alice Nova',
      online: true,
      version: alice.version + 1,
    });
    expect(users.get('alice')?.version).toBe(alice.version + 1);

    // Overlap window: memberJoined / memberLeft arriving on both sockets only produce one notice.
    const carla = { username: 'carla', displayName: 'Carla', online: true, version: 1 };
    first.receive({ type: 'memberJoined', conversationId: 'g:1', member: carla });
    second.receive({ type: 'memberJoined', conversationId: 'g:1', member: carla });
    first.receive({ type: 'memberLeft', conversationId: 'g:1', username: 'bruno' });
    second.receive({ type: 'memberLeft', conversationId: 'g:1', username: 'bruno' });
    expect(messages.noticesIn('g:1').map((n) => [n.kind, n.username])).toEqual([
      ['joined', 'carla'],
      ['left', 'bruno'],
    ]);

    // Answering the pending getHistory drains and closes the first socket without dropping.
    answer(first, { messages: [], hasMore: false });
    await Promise.resolve();
    expect(first.closed).toBe(true);
    expect(connection.connected()).toBe(true);
  });

  it('keeps the active session intact when the parallel displayName connection fails (RF01)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { session, sockets } = setUp();
    const entering = session.enter('alice', 'Alice');
    sockets[0]!.open();
    await Promise.resolve();
    answer(sockets[0]!, { serverTime: 1000, updated: [], conversations: [fromBruno] });
    await entering;

    const changing = session.changeDisplayName('Alice Falhou');
    sockets[1]!.drop();
    await expect(changing).resolves.toBe(false);

    expect(sockets[0]!.closed).toBe(false);
    expect(TestBed.inject(ConnectionStore).connected()).toBe(true);
    expect(session.user()?.displayName).toBe('Alice');
    expect(JSON.parse(localStorage.getItem(userStorageKey('alice'))!)).toEqual({
      displayName: 'Alice',
    });
  });

  it('persists current user only after entering succeeds and clears saved displayName when entering blank (RF01)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { session, sockets } = setUp();
    localStorage.setItem(
      userStorageKey('alice'),
      JSON.stringify({ displayName: 'Alice Antiga', seen: { 'd:alice:bruno': 500 } }),
    );

    // Refused handshake never writes current-user nor erases saved displayName.
    const failed = session.enter('alice', '');
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
    sockets[0]!.drop();
    await failed;
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(userStorageKey('alice'))!)).toMatchObject({
      displayName: 'Alice Antiga',
    });

    // A sync that fails after the socket opens doesn't write it either.
    const syncFails = session.enter('alice', '');
    sockets[1]!.open();
    await Promise.resolve();
    sockets[1]!.drop();
    await syncFails;
    expect(session.enterStatus()).toBe('failed');
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();

    // Successful entry without displayName writes current-user after sync and clears saved
    // displayName.
    const entering = session.enter('alice', '');
    sockets[2]!.open();
    await Promise.resolve();
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
    expect(new URL(sockets[2]!.url).searchParams.has('displayName')).toBe(false);
    answer(sockets[2]!, { serverTime: 1000, updated: [], conversations: [] });
    await entering;
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBe('alice');
    expect(JSON.parse(localStorage.getItem(userStorageKey('alice'))!)).toEqual({
      seen: { 'd:alice:bruno': 500 },
    });

    session.leave();
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
  });

  it('restores a persisted session with automatic exponential reconnect and drops invalid displayName (RF01)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { session, sockets } = setUp();
    localStorage.setItem(CURRENT_USER_STORAGE_KEY, 'alice');
    localStorage.setItem(
      userStorageKey('alice'),
      JSON.stringify({ displayName: 'Ana\nInvalida', seen: { 'd:alice:bruno': 500 } }),
    );

    expect(session.restore()).toBe(true);
    expect(session.user()).toEqual({ username: 'alice', displayName: 'alice' });
    expect(new URL(sockets[0]!.url).searchParams.has('displayName')).toBe(false);
    expect(JSON.parse(localStorage.getItem(userStorageKey('alice'))!)).toEqual({
      seen: { 'd:alice:bruno': 500 },
    });

    // Failure to open triggers exponential backoff reconnect (RF08).
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(RECONNECT_INITIAL_DELAY_MS);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    await vi.advanceTimersByTimeAsync(0);
    answer(sockets[1]!, { serverTime: 2000, updated: [], conversations: [fromBruno] });
    await vi.advanceTimersByTimeAsync(0);

    expect(TestBed.inject(ConnectionStore).connected()).toBe(true);
    expect(TestBed.inject(ConversationsStore).loading()).toBe(false);
  });

  it('synchronizes logout, user switch, seen marks and displayName across tabs via storage (RF01)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { session, sockets } = setUp();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    const entering = session.enter('alice', 'Alice');
    sockets[0]!.open();
    await Promise.resolve();
    answer(sockets[0]!, { serverTime: 1000, updated: [], conversations: [fromBruno] });
    await entering;

    const conversations = TestBed.inject(ConversationsStore);
    expect(conversations.withNewActivity().has('d:alice:bruno')).toBe(true);

    // Another tab of alice marks the chat as seen and updates displayName.
    localStorage.setItem(
      userStorageKey('alice'),
      JSON.stringify({ displayName: 'Alice Aba 2', seen: { 'd:alice:bruno': 900 } }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', { key: userStorageKey('alice'), storageArea: localStorage }),
    );
    expect(conversations.withNewActivity().size).toBe(0);
    expect(session.user()?.displayName).toBe('Alice Aba 2');

    // Another tab switches browser user to bruno.
    localStorage.setItem(userStorageKey('bruno'), JSON.stringify({ displayName: 'Bruno Lima' }));
    localStorage.setItem(CURRENT_USER_STORAGE_KEY, 'bruno');
    window.dispatchEvent(
      new StorageEvent('storage', { key: CURRENT_USER_STORAGE_KEY, storageArea: localStorage }),
    );
    expect(sockets[0]!.closed).toBe(true);
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBe('bruno');
    expect(session.user()).toEqual({ username: 'bruno', displayName: 'Bruno Lima' });
    expect(new URL(sockets[1]!.url).searchParams.get('username')).toBe('bruno');
    expect(new URL(sockets[1]!.url).searchParams.get('displayName')).toBe('Bruno Lima');
    expect(navigate).toHaveBeenCalledWith('/');

    // Another tab logs out (clears hub:current-user).
    localStorage.removeItem(CURRENT_USER_STORAGE_KEY);
    window.dispatchEvent(
      new StorageEvent('storage', { key: CURRENT_USER_STORAGE_KEY, storageArea: localStorage }),
    );
    expect(sockets[1]!.closed).toBe(true);
    expect(session.user()).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/entrar');
  });
});
