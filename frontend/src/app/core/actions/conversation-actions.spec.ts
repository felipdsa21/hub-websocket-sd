import { TestBed } from '@angular/core/testing';
import {
  ALICE_BRUNO,
  BRUNO,
  GROUP,
  aliceBrunoChat,
  answer,
  enterTestSession,
  refuse,
} from '@/core/hub/testing';
import { ConversationsStore } from '@/core/state/conversations-store';
import { UsersStore } from '@/core/state/users-store';
import { ConversationActions } from './conversation-actions';

describe('ConversationActions', () => {
  it("opens a direct chat with openDirect and keeps the members' states", async () => {
    const socket = await enterTestSession([]);
    const conversations = TestBed.inject(ConversationsStore);
    const opening = TestBed.inject(ConversationActions).openDirect('bruno');
    expect(socket.last()).toMatchObject({ action: 'openDirect', username: 'bruno' });

    answer(socket, { conversation: aliceBrunoChat() });

    expect(await opening).toEqual({ conversationId: ALICE_BRUNO });
    expect(conversations.get(ALICE_BRUNO)?.members).toEqual(['alice', 'bruno']);
    expect(TestBed.inject(UsersStore).get('bruno')).toEqual(BRUNO);
  });

  it('returns the error of a refused openDirect', async () => {
    const socket = await enterTestSession([]);
    const opening = TestBed.inject(ConversationActions).openDirect('ninguem');
    refuse(socket, 'notFound', { usernames: ['ninguem'] });
    expect(await opening).toMatchObject({ code: 'notFound', details: { usernames: ['ninguem'] } });
  });

  it('creates a group with the trimmed name and the chosen members', async () => {
    const socket = await enterTestSession([]);
    const conversations = TestBed.inject(ConversationsStore);
    const creating = TestBed.inject(ConversationActions).createGroup('  SD  ', ['bruno']);
    expect(socket.last()).toMatchObject({ action: 'createGroup', name: 'SD', members: ['bruno'] });

    answer(socket, { conversation: GROUP });

    expect(await creating).toEqual({ conversationId: 'g:1' });
    expect(conversations.get('g:1')?.name).toBe('SD');
  });
});
