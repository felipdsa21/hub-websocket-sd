import { TestBed } from '@angular/core/testing';
import { ALICE, BRUNO, answer, enterTestSession, refuse } from '@/core/hub/testing';
import { ConversationsStore } from '@/core/state/conversations-store';
import { MessagesStore } from '@/core/state/messages-store';
import { GroupActions } from './group-actions';

const CARLA = { username: 'carla', displayName: 'Carla', online: false, version: 2 };
const GROUP = {
  conversationId: 'g:1',
  type: 'group',
  name: 'SD',
  members: [ALICE, BRUNO],
  joinedAt: 500,
};

describe('GroupActions', () => {
  it('adds one person at a time and records each notice once', async () => {
    const socket = await enterTestSession([GROUP]);
    const conversations = TestBed.inject(ConversationsStore);
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
    const socket = await enterTestSession([GROUP]);
    const conversations = TestBed.inject(ConversationsStore);
    const adding = TestBed.inject(GroupActions).addMembers('g:1', ['carla']);
    answer(socket, {});
    await adding;
    expect(conversations.get('g:1')?.members).toContain('carla');
  });

  it('leaves a group, sending confirm only when the user agreed to leave it empty', async () => {
    const socket = await enterTestSession([GROUP]);
    const conversations = TestBed.inject(ConversationsStore);
    const actions = TestBed.inject(GroupActions);

    const refused = actions.leave('g:1');
    expect(socket.last()).not.toHaveProperty('confirm');
    refuse(socket, 'lastMember');
    expect(await refused).toMatchObject({ code: 'lastMember' });
    expect(conversations.get('g:1')).toBeDefined();

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
