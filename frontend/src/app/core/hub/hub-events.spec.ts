import { TestBed } from '@angular/core/testing';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { ConversationsStore } from '@/core/state/conversations-store';
import { MessagesStore } from '@/core/state/messages-store';
import { SessionStore } from '@/core/state/session-store';
import { UsersStore } from '@/core/state/users-store';
import {
  ALICE,
  ALICE_BRUNO,
  BRUNO,
  FakeWebSocket,
  aliceBrunoChat,
  answer,
  enterAsAlice,
  provideFakeSockets,
  useTestBackend,
} from './testing';

const CARLA = { username: 'carla', displayName: 'Carla', online: false, version: 2 };
const GROUP = {
  conversationId: 'g:1',
  type: 'group',
  name: 'SD',
  members: [ALICE, BRUNO],
  joinedAt: 500,
};

async function setUp(conversations?: unknown[]) {
  localStorage.clear();
  const sockets: FakeWebSocket[] = [];
  TestBed.configureTestingModule({
    providers: [...provideTestFixtures(), ...provideFakeSockets(sockets)],
  });
  useTestBackend();
  const session = TestBed.inject(SessionStore);
  const socket = await enterAsAlice((u, d) => session.enter(u, d), sockets, conversations);
  return {
    socket,
    session,
    conversations: TestBed.inject(ConversationsStore),
    users: TestBed.inject(UsersStore),
    messages: TestBed.inject(MessagesStore),
  };
}

describe('HubEvents', () => {
  it('adds a conversation with its members from conversationAdded', async () => {
    const { socket, conversations, users } = await setUp([]);
    socket.receive({ type: 'conversationAdded', conversation: aliceBrunoChat() });

    expect(conversations.get(ALICE_BRUNO)?.members).toEqual(['alice', 'bruno']);
    expect(users.get('bruno')).toEqual(BRUNO);
  });

  it('removes a conversation from conversationRemoved', async () => {
    const { socket, conversations } = await setUp([aliceBrunoChat(), GROUP]);
    socket.receive({ type: 'conversationRemoved', conversationId: 'g:1' });
    expect(conversations.get('g:1')).toBeUndefined();
  });

  it('adds and removes members with a notice in the conversation', async () => {
    const { socket, conversations, users, messages } = await setUp([GROUP]);
    socket.receive({ type: 'memberJoined', conversationId: 'g:1', member: CARLA });
    expect(conversations.get('g:1')?.members).toEqual(['alice', 'bruno', 'carla']);
    expect(users.get('carla')).toEqual(CARLA);

    socket.receive({ type: 'memberLeft', conversationId: 'g:1', username: 'bruno' });
    expect(conversations.get('g:1')?.members).toEqual(['alice', 'carla']);
    expect(messages.noticesIn('g:1').map((n) => [n.kind, n.username])).toEqual([
      ['joined', 'carla'],
      ['left', 'bruno'],
    ]);
  });

  it('applies presence only when it is newer, and logs each announcement', async () => {
    const { socket, users } = await setUp();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    socket.receive({ type: 'presence', ...BRUNO, online: false, version: 8 });
    socket.receive({ type: 'presence', ...BRUNO, online: true, version: 6 });
    expect(users.get('bruno')).toMatchObject({ online: false, version: 8 });
    expect(info.mock.calls.map((c) => c[0])).toEqual([
      'Presence: bruno offline, version 8.',
      'Presence: bruno online, version 6.',
    ]);
  });

  it('applies the events that arrive before the answer of the entry sync', async () => {
    localStorage.clear();
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [...provideTestFixtures(), ...provideFakeSockets(sockets)],
    });
    useTestBackend();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const entering = TestBed.inject(SessionStore).enter('alice', 'Alice');
    const socket = sockets[0]!;
    socket.open();
    await Promise.resolve();
    const sync = socket.last();

    socket.receive({
      type: 'message',
      conversationId: ALICE_BRUNO,
      sk: 'm#0000000002000#bruno#b2',
      messageId: 'b2',
      sender: 'bruno',
      text: 'oi',
      sentAt: 2000,
    });
    socket.receive({ type: 'presence', ...BRUNO, online: false, version: 8 });
    socket.receive({
      type: 'response',
      requestId: sync.requestId,
      data: { serverTime: 1000, updated: [], conversations: [aliceBrunoChat()] },
    });
    await entering;

    expect(TestBed.inject(ConversationsStore).get(ALICE_BRUNO)).toMatchObject({
      lastMessageAt: 2000,
      lastMessageBy: 'bruno',
    });
    expect(TestBed.inject(UsersStore).get('bruno')).toMatchObject({ online: false, version: 8 });
  });

  it('asks sync for a message of a conversation it does not know yet', async () => {
    const { socket, conversations } = await setUp([]);
    socket.receive({
      type: 'message',
      conversationId: ALICE_BRUNO,
      sk: 'm#0000000001000#bruno#b1',
      messageId: 'b1',
      sender: 'bruno',
      text: 'oi',
      sentAt: 1000,
    });
    expect(socket.last()).toMatchObject({ action: 'sync' });

    answer(socket, {
      serverTime: 1100,
      updated: [ALICE_BRUNO],
      conversations: [aliceBrunoChat({ lastMessageAt: 1000, lastMessageBy: 'bruno' })],
    });
    await new Promise((resolve) => setTimeout(resolve));

    expect(conversations.withNewActivity().has(ALICE_BRUNO)).toBe(true);
  });

  it('stops applying events after leaving', async () => {
    const { socket, session, conversations } = await setUp([]);
    session.leave();
    socket.receive({ type: 'conversationAdded', conversation: aliceBrunoChat() });
    expect(conversations.get(ALICE_BRUNO)).toBeUndefined();
  });
});
