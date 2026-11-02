import { Conversation } from './conversation';
import { compareConversations, hasNewActivity } from './conversation-rules';

function conversation(id: string, fields: Partial<Conversation> = {}): Conversation {
  return { conversationId: id, type: 'group', members: [], joinedAt: 0, ...fields };
}

describe('conversation rules', () => {
  it('puts conversations without messages first, the most recently joined on top', () => {
    const list = [
      conversation('g:old', { lastMessageAt: 500, lastMessageBy: 'a' }),
      conversation('g:new', { lastMessageAt: 900, lastMessageBy: 'a' }),
      conversation('g:empty-first', { joinedAt: 100 }),
      conversation('g:empty-last', { joinedAt: 200 }),
    ];
    expect(list.sort(compareConversations).map((c) => c.conversationId)).toEqual([
      'g:empty-last',
      'g:empty-first',
      'g:new',
      'g:old',
    ]);
  });

  it('breaks ties on the last message by sender, as the sk does', () => {
    const list = [
      conversation('g:a', { lastMessageAt: 500, lastMessageBy: 'ana' }),
      conversation('g:b', { lastMessageAt: 500, lastMessageBy: 'bruno' }),
    ];
    expect(list.sort(compareConversations).map((c) => c.conversationId)).toEqual(['g:b', 'g:a']);
  });

  it('marks a conversation whose last message from someone else is newer than the seen one', () => {
    const c = conversation('g:x', { lastMessageAt: 500, lastMessageBy: 'bruno' });
    expect(hasNewActivity(c, 'marina', 400)).toBe(true);
    expect(hasNewActivity(c, 'marina', 500)).toBe(false);
    expect(hasNewActivity(c, 'marina')).toBe(true);
  });

  it("doesn't mark a conversation whose last message is the user's own or that has none", () => {
    expect(
      hasNewActivity(
        conversation('g:x', { lastMessageAt: 500, lastMessageBy: 'marina' }),
        'marina',
      ),
    ).toBe(false);
    expect(hasNewActivity(conversation('g:x'), 'marina')).toBe(false);
  });
});
