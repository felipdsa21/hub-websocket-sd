import { TestBed } from '@angular/core/testing';
import { provideTestFixtures } from '@/core/fixtures/testing';
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
} from '@/core/hub/testing';
import { ConversationsStore } from '@/core/state/conversations-store';
import { DirectoryStore, SEARCH_DELAY_MS } from '@/core/state/directory-store';
import { MessagesStore } from '@/core/state/messages-store';
import { SearchStore } from '@/core/state/search-store';
import { SessionStore } from '@/core/state/session-store';
import { UsersStore } from '@/core/state/users-store';
import { ConversationActions } from './conversation-actions';
import { GroupActions } from './group-actions';

const CARLA = { username: 'carla', displayName: 'Carla', online: false, version: 2 };
const DIEGO = { username: 'diego', displayName: 'Diego', online: true, version: 4 };
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
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const session = TestBed.inject(SessionStore);
  const socket = await enterAsAlice((u, d) => session.enter(u, d), sockets, conversations);
  return { socket, conversations: TestBed.inject(ConversationsStore) };
}

function refuse(socket: FakeWebSocket, code: string, details?: unknown) {
  socket.receive({
    type: 'error',
    requestId: socket.last().requestId,
    code,
    message: code,
    ...(details !== undefined && { details }),
  });
}

describe('ConversationActions with the backend', () => {
  it('opens a direct chat with openDirect and keeps the members states', async () => {
    const { socket, conversations } = await setUp([]);
    const opening = TestBed.inject(ConversationActions).openDirect('bruno');
    expect(socket.last()).toMatchObject({ action: 'openDirect', username: 'bruno' });

    answer(socket, { conversation: aliceBrunoChat() });

    expect(await opening).toEqual({ conversationId: ALICE_BRUNO });
    expect(conversations.get(ALICE_BRUNO)?.members).toEqual(['alice', 'bruno']);
    expect(TestBed.inject(UsersStore).get('bruno')).toEqual(BRUNO);
  });

  it('returns the error of a refused openDirect', async () => {
    const { socket } = await setUp([]);
    const opening = TestBed.inject(ConversationActions).openDirect('ninguem');
    refuse(socket, 'notFound', { usernames: ['ninguem'] });
    expect(await opening).toMatchObject({ code: 'notFound', details: { usernames: ['ninguem'] } });
  });

  it('creates a group with the trimmed name and the chosen members', async () => {
    const { socket, conversations } = await setUp([]);
    const creating = TestBed.inject(ConversationActions).createGroup('  SD  ', ['bruno']);
    expect(socket.last()).toMatchObject({ action: 'createGroup', name: 'SD', members: ['bruno'] });

    answer(socket, { conversation: GROUP });

    expect(await creating).toEqual({ conversationId: 'g:1' });
    expect(conversations.get('g:1')?.name).toBe('SD');
  });
});

describe('GroupActions with the backend', () => {
  it('adds one person at a time and records each notice once', async () => {
    const { socket, conversations } = await setUp([GROUP]);
    const adding = TestBed.inject(GroupActions).addMembers('g:1', ['carla', 'diego']);

    expect(socket.last()).toMatchObject({
      action: 'addMember',
      conversationId: 'g:1',
      username: 'carla',
    });
    // The backend sends memberJoined to the members before answering.
    socket.receive({ type: 'memberJoined', conversationId: 'g:1', member: CARLA });
    answer(socket, {});
    await vi.waitFor(() => expect(socket.last()).toMatchObject({ username: 'diego' }));
    refuse(socket, 'notFound');

    expect(await adding).toEqual({
      added: ['carla'],
      failed: [{ username: 'diego', reason: { code: 'notFound', message: 'notFound' } }],
    });
    expect(conversations.get('g:1')?.members).toEqual(['alice', 'bruno', 'carla']);
    expect(
      TestBed.inject(MessagesStore)
        .noticesIn('g:1')
        .map((n) => n.username),
    ).toEqual(['carla']);
  });

  it('adds the member from the answer when memberJoined did not arrive', async () => {
    const { socket, conversations } = await setUp([GROUP]);
    const adding = TestBed.inject(GroupActions).addMembers('g:1', ['carla']);
    answer(socket, {});
    await adding;
    expect(conversations.get('g:1')?.members).toContain('carla');
  });

  it('leaves a group, sending confirm only when the user agreed to leave it empty', async () => {
    const { socket, conversations } = await setUp([GROUP]);
    const actions = TestBed.inject(GroupActions);

    const refused = actions.leave('g:1');
    expect(socket.last()).not.toHaveProperty('confirm');
    refuse(socket, 'lastMember');
    expect(await refused).toMatchObject({ code: 'lastMember' });

    const leaving = actions.leave('g:1', true);
    expect(socket.last()).toMatchObject({
      action: 'leaveGroup',
      conversationId: 'g:1',
      confirm: true,
    });
    answer(socket, {});
    expect(await leaving).toBe('left');
    expect(conversations.get('g:1')).toBeUndefined();
  });
});

describe('Searches with the backend', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for a pause in typing and keeps only the answer of the last search', async () => {
    const { socket } = await setUp([GROUP, aliceBrunoChat()]);
    vi.useFakeTimers();
    const search = TestBed.inject(SearchStore);

    search.search('b');
    search.search('br');
    expect(search.status()).toBe('loading');
    vi.advanceTimersByTime(SEARCH_DELAY_MS);
    const searches = () => socket.sent.filter((r) => r['action'] === 'search');
    expect(searches().map((r) => r['query'])).toEqual(['br']);

    answer(socket, { conversations: [aliceBrunoChat(), GROUP], people: [DIEGO] });
    await vi.advanceTimersByTimeAsync(0);

    expect(search.status()).toBe('done');
    // In the order of the list: the group, without messages, comes first.
    expect(search.results().conversations.map((c) => c.conversationId)).toEqual([
      'g:1',
      ALICE_BRUNO,
    ]);
    expect(search.results().people).toEqual([DIEGO]);
  });

  it('shows the error of a failed search', async () => {
    const { socket } = await setUp();
    vi.useFakeTimers();
    const search = TestBed.inject(SearchStore);
    search.search('br');
    vi.advanceTimersByTime(SEARCH_DELAY_MS);
    refuse(socket, 'invalidRequest');
    await vi.advanceTimersByTimeAsync(0);
    expect(search.status()).toBe('error');
  });

  it('finds people to choose, including those with a direct chat', async () => {
    const { socket } = await setUp();
    const directory = TestBed.inject(DirectoryStore);
    const finding = directory.findPeople('  b  ');
    expect(socket.last()).toMatchObject({ action: 'search', query: 'b' });

    answer(socket, { conversations: [aliceBrunoChat()], people: [CARLA] });

    expect((await finding).map((u) => u.username)).toEqual(['bruno', 'carla']);
    expect(directory.get('carla')).toEqual(CARLA);
  });
});
