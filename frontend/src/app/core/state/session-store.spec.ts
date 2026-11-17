import { TestBed } from '@angular/core/testing';
import { HubFixtures } from '@/core/fixtures/hub-fixtures';
import { Scenario } from '@/core/fixtures/scenarios';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { DEV_MODE, HubConfig } from '@/core/hub/hub-config';
import { FakeWebSocket, provideFakeSockets, useTestBackend } from '@/core/hub/testing';
import { ConversationsStore } from './conversations-store';
import { SessionStore } from './session-store';
import { userStorageKey } from './user-storage';
import { UsersStore } from './users-store';

function setUp(scenarios: readonly Scenario[] = []) {
  TestBed.configureTestingModule({ providers: provideTestFixtures({ scenarios }) });
  return TestBed.inject(SessionStore);
}

describe('SessionStore', () => {
  it('enters in place of Marina, with the conversation list of the design', () => {
    const session = setUp();
    session.enter('Ju.Teste', '  Ju  ');

    expect(session.user()).toEqual({ username: 'ju.teste', displayName: 'Ju' });
    const conversations = TestBed.inject(ConversationsStore);
    const users = TestBed.inject(UsersStore);
    const names = conversations
      .sorted()
      .map((c) =>
        c.type === 'group'
          ? c.name
          : users.get(c.members.find((m) => m !== 'ju.teste')!)?.displayName,
      );
    expect(names).toEqual([
      'Equipe SD',
      'Bruno Lima',
      'Trabalho final',
      'Carla Souza',
      'Semana de provas',
      'Diego Martins',
      'Eduarda Rocha',
      'Ana Lima',
      'Ana Lima',
    ]);
    expect([...conversations.withNewActivity()].map((id) => conversations.get(id)?.name)).toEqual([
      'Trabalho final',
    ]);
  });

  it('uses the username when the display name is empty', () => {
    const session = setUp();
    session.enter('marina', '   ');
    expect(session.user()?.displayName).toBe('marina');
  });

  it('only knows users who share a conversation, so a member who left shows by username', () => {
    setUp().enter('marina', 'Marina Alves');
    const users = TestBed.inject(UsersStore);
    expect(users.get('bruno')?.displayName).toBe('Bruno Lima');
    expect(users.get('gabriel.nunes')).toBeUndefined();
  });

  it('has more than two pages of history in Equipe SD', () => {
    setUp().enter('marina', 'Marina Alves');
    const messages = TestBed.inject(HubFixtures).data()!.messages;
    const team = TestBed.inject(ConversationsStore).sorted()[0]!;
    expect(messages.filter((m) => m.conversationId === team.conversationId).length).toBeGreaterThan(
      100,
    );
    expect(new Set(messages.map((m) => m.messageId)).size).toBe(messages.length);
  });

  it('fails or keeps connecting in the entry scenarios', () => {
    expect(withScenario('entrar-falha')).toBe('failed');
    TestBed.resetTestingModule();
    expect(withScenario('carregando')).toBe('connecting');

    function withScenario(scenario: Scenario) {
      const session = setUp([scenario]);
      session.enter('marina', '');
      expect(session.user()).toBeNull();
      return session.enterStatus();
    }
  });

  it('starts without conversations in the "sem-conversas" scenario', () => {
    setUp(['sem-conversas']).enter('marina', '');
    expect(TestBed.inject(ConversationsStore).sorted()).toEqual([]);
  });

  it('changes the display name with a newer version of the own state', () => {
    const session = setUp();
    session.enter('marina', 'Marina Alves');
    const users = TestBed.inject(UsersStore);
    const before = users.get('marina')!.version;

    session.changeDisplayName('  Marina A.  ');

    expect(session.user()?.displayName).toBe('Marina A.');
    expect(users.get('marina')).toMatchObject({ displayName: 'Marina A.', version: before + 1 });
  });
});

describe('SessionStore with the backend', () => {
  beforeEach(() => localStorage.clear());

  function setUpLive() {
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [...provideTestFixtures(), ...provideFakeSockets(sockets)],
    });
    useTestBackend();
    return { session: TestBed.inject(SessionStore), sockets };
  }

  const alice = { username: 'alice', displayName: 'Alice', online: true, version: 3 };
  const bruno = { username: 'bruno', displayName: 'Bruno', online: false, version: 7 };

  it('connects, loads the list with sync and only then enters', async () => {
    const { session, sockets } = setUpLive();
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
    expect(TestBed.inject(HubFixtures).data()).toBeNull();
  });

  it('keeps the own state when there is no conversation', async () => {
    const { session, sockets } = setUpLive();
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

    expect(new URL(socket.url).searchParams.has('displayName')).toBe(false);
    expect(TestBed.inject(UsersStore).get('alice')).toMatchObject({ displayName: 'alice' });
  });

  it('shows a failure to enter when the connection is refused', async () => {
    const { session, sockets } = setUpLive();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const entering = session.enter('alice', '');
    sockets[0]!.drop();
    await entering;

    expect(session.enterStatus()).toBe('failed');
    expect(session.user()).toBeNull();
  });

  it('closes the connection when leaving', async () => {
    const { session, sockets } = setUpLive();
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
    const { session, sockets } = setUpLive();
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
        ...provideTestFixtures(),
        ...provideFakeSockets(sockets),
        { provide: DEV_MODE, useValue: false },
      ],
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.inject(HubConfig).use({ websocketUrl: 'ws://hub.example/dev' });
    const session = TestBed.inject(SessionStore);

    await session.enter('alice', '');

    expect(session.enterStatus()).toBe('failed');
    expect(sockets).toEqual([]);
  });
});
