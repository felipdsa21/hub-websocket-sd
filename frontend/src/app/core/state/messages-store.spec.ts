import { TestBed } from '@angular/core/testing';
import { REQUEST_TIMEOUT_MS } from '@/core/hub/hub-socket';
import { ALICE_BRUNO, aliceBrunoChat, answer, enterTestSession } from '@/core/hub/testing';
import { Message, messageSk } from '@/core/model/message';
import { ConversationsStore } from './conversations-store';
import { MessagesStore, mergeMessages } from './messages-store';

const ID1 = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';

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

async function setUp(conversations?: unknown[]) {
  const socket = await enterTestSession(conversations);
  return { socket, messages: TestBed.inject(MessagesStore) };
}

/** Lets the promise callbacks of the store run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('MessagesStore', () => {
  afterEach(() => vi.useRealTimers());

  it('loads the latest page with getHistory and the older ones with before', async () => {
    const { socket, messages } = await setUp();
    messages.open(ALICE_BRUNO);
    expect(socket.last()).toMatchObject({ action: 'getHistory', conversationId: ALICE_BRUNO });
    expect(socket.last()).not.toHaveProperty('before');
    expect(messages.history(ALICE_BRUNO)?.status).toBe('loading');

    const latest = message('bruno', 2000, 'm2');
    answer(socket, { messages: [latest], hasMore: true });
    await settle();
    expect(messages.history(ALICE_BRUNO)).toMatchObject({ status: 'loaded', hasOlder: true });

    messages.loadOlder(ALICE_BRUNO);
    expect(socket.last()).toMatchObject({ action: 'getHistory', before: latest.sk });
    const older = message('alice', 1000, 'm1');
    answer(socket, { messages: [older], hasMore: false });
    await settle();

    const history = messages.history(ALICE_BRUNO)!;
    expect(history.messages).toEqual([older, latest]);
    expect(history.hasOlder).toBe(false);
  });

  it('shows the history error when getHistory fails', async () => {
    const { socket, messages } = await setUp();
    messages.open(ALICE_BRUNO);
    socket.receive({
      type: 'error',
      requestId: socket.last().requestId,
      code: 'forbidden',
      message: 'no',
    });
    await settle();
    expect(messages.history(ALICE_BRUNO)?.status).toBe('error');
  });

  it('ignores a getHistory failure that arrives after a reset', async () => {
    const { socket, messages } = await setUp();
    messages.open(ALICE_BRUNO);
    answer(socket, { messages: [message('bruno', 2000, ID2)], hasMore: true });
    await settle();
    messages.loadOlder(ALICE_BRUNO);

    messages.reset();
    socket.receive({
      type: 'error',
      requestId: socket.last().requestId,
      code: 'conflict',
      message: 'no',
    });
    await settle();

    expect(messages.history(ALICE_BRUNO)).toBeUndefined();
  });

  it('keeps a message pending until its own message event confirms it', async () => {
    const { socket, messages } = await setUp();
    messages.open(ALICE_BRUNO);
    answer(socket, { messages: [], hasMore: false });
    await settle();

    messages.send(ALICE_BRUNO, 'Olá!', ID1);
    expect(socket.last()).toMatchObject({
      action: 'sendMessage',
      conversationId: ALICE_BRUNO,
      messageId: ID1,
      text: 'Olá!',
    });
    expect(messages.pendingCount()).toBe(1);

    const confirmed = message('alice', 5000, ID1, 'Olá!');
    socket.receive({ type: 'message', ...confirmed });

    expect(messages.pendingCount()).toBe(0);
    expect(messages.history(ALICE_BRUNO)?.messages).toEqual([confirmed]);
    const conversation = TestBed.inject(ConversationsStore).get(ALICE_BRUNO);
    expect(conversation).toMatchObject({ lastMessageAt: 5000, lastMessageBy: 'alice' });
  });

  it('keeps a message pending, without sending it, while the connection is lost', async () => {
    const { socket, messages } = await setUp();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    socket.drop();

    messages.send(ALICE_BRUNO, 'Pendente', ID1);

    expect(socket.sent.some((r) => r['action'] === 'sendMessage')).toBe(false);
    expect(messages.outgoingIn(ALICE_BRUNO)).toEqual([
      { conversationId: ALICE_BRUNO, messageId: ID1, text: 'Pendente' },
    ]);
    expect(messages.pendingCount()).toBe(1);
  });

  it('sends the pending messages of a conversation one at a time', async () => {
    const { socket, messages } = await setUp();
    messages.send(ALICE_BRUNO, 'um', ID1);
    messages.send(ALICE_BRUNO, 'dois', ID2);
    const sends = () => socket.sent.filter((r) => r['action'] === 'sendMessage');
    expect(sends().map((r) => r['messageId'])).toEqual([ID1]);

    socket.receive({ type: 'message', ...message('alice', 5000, ID1, 'um') });

    expect(sends().map((r) => r['messageId'])).toEqual([ID1, ID2]);
  });

  it('resends with the same messageId after 15 s without confirmation (RF12)', async () => {
    vi.useFakeTimers();
    const { socket, messages } = await setUp();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    messages.send(ALICE_BRUNO, 'Olá!', ID1);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    const sends = socket.sent.filter((r) => r['action'] === 'sendMessage');
    expect(sends.map((r) => r['messageId'])).toEqual([ID1, ID1]);
    expect(sends[0]!['requestId']).not.toBe(sends[1]!['requestId']);
    expect(console.info).toHaveBeenCalled();
  });

  it('marks a refused message as not sent and goes on with the next', async () => {
    const { socket, messages } = await setUp();
    messages.send(ALICE_BRUNO, 'x'.repeat(10), ID1);
    messages.send(ALICE_BRUNO, 'dois', ID2);
    socket.receive({
      type: 'error',
      requestId: socket.last().requestId,
      messageId: ID1,
      code: 'invalidRequest',
      message: 'text: invalid',
      details: { field: 'text' },
    });
    await settle();

    const [refused, next] = messages.outgoingIn(ALICE_BRUNO);
    expect(refused).toMatchObject({ messageId: ID1, error: { code: 'invalidRequest' } });
    expect(next?.error).toBeUndefined();
    expect(socket.last()).toMatchObject({ action: 'sendMessage', messageId: ID2 });

    messages.discard(ID1);
    expect(messages.outgoingIn(ALICE_BRUNO).map((m) => m.messageId)).toEqual([ID2]);
  });

  it('marks a refused message as not sent even when error has messageId without requestId (RF12)', async () => {
    const { socket, messages } = await setUp();
    messages.send(ALICE_BRUNO, 'um', ID1);
    messages.send(ALICE_BRUNO, 'dois', ID2);
    socket.receive({
      type: 'error',
      messageId: ID1,
      code: 'forbidden',
      message: 'not a member',
    });
    await settle();

    const [refused, next] = messages.outgoingIn(ALICE_BRUNO);
    expect(refused).toMatchObject({ messageId: ID1, error: { code: 'forbidden' } });
    expect(next?.error).toBeUndefined();
    expect(socket.last()).toMatchObject({ action: 'sendMessage', messageId: ID2 });
  });

  it('puts received messages in sk order, once each, whatever the arrival order', async () => {
    const { socket, messages } = await setUp();
    messages.open(ALICE_BRUNO);
    answer(socket, { messages: [], hasMore: false });
    await settle();

    const first = message('bruno', 1000, 'b1');
    const tie = message('alice', 1000, 'a1');
    const later = message('bruno', 2000, 'b2');
    for (const m of [later, first, tie, first]) {
      socket.receive({ type: 'message', ...m });
    }

    expect(messages.history(ALICE_BRUNO)?.messages).toEqual([tie, first, later]);
  });

  it("marks someone else's message as seen only while its conversation is on screen", async () => {
    const { socket } = await setUp();
    const conversations = TestBed.inject(ConversationsStore);

    socket.receive({ type: 'message', ...message('bruno', 1000, 'b1') });
    expect(conversations.withNewActivity().has(ALICE_BRUNO)).toBe(true);

    conversations.open(ALICE_BRUNO);
    socket.receive({ type: 'message', ...message('bruno', 2000, 'b2') });
    expect(conversations.withNewActivity().has(ALICE_BRUNO)).toBe(false);

    conversations.close(ALICE_BRUNO);
    socket.receive({ type: 'message', ...message('bruno', 3000, 'b3') });
    expect(conversations.withNewActivity().has(ALICE_BRUNO)).toBe(true);
  });

  it('keeps a message that arrives while the history loads', async () => {
    const { socket, messages } = await setUp([aliceBrunoChat()]);
    messages.open(ALICE_BRUNO);
    const request = socket.last();
    const early = message('bruno', 3000, 'b3');
    const page = message('bruno', 2000, 'b2');
    socket.receive({ type: 'message', ...early });
    socket.receive({
      type: 'response',
      requestId: request.requestId,
      data: { messages: [page, early], hasMore: false },
    });
    await settle();

    expect(messages.history(ALICE_BRUNO)?.messages).toEqual([page, early]);
  });
});

describe('mergeMessages', () => {
  it('keeps the known list when nothing new arrives', () => {
    const known = [message('bruno', 1000, 'b1')];
    expect(mergeMessages(known, [message('bruno', 1000, 'b1')])).toBe(known);
  });

  it('tells apart the same messageId from different senders', () => {
    const merged = mergeMessages([message('bruno', 1000, 'x')], [message('alice', 1000, 'x')]);
    expect(merged.map((m) => m.sender)).toEqual(['alice', 'bruno']);
  });
});
