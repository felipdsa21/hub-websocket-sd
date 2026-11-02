import { Conversation } from './conversation';

/**
 * List order (RF10): conversations without messages first, the most recently joined on top; then
 * by last message, the most recent first, breaking ties by sender as the `sk` does.
 */
export function compareConversations(a: Conversation, b: Conversation): number {
  if (a.lastMessageAt === undefined || b.lastMessageAt === undefined) {
    if (a.lastMessageAt !== b.lastMessageAt) {
      return a.lastMessageAt === undefined ? -1 : 1;
    }
    return b.joinedAt - a.joinedAt || compareStrings(a.conversationId, b.conversationId);
  }
  return (
    b.lastMessageAt - a.lastMessageAt ||
    compareStrings(b.lastMessageBy ?? '', a.lastMessageBy ?? '') ||
    compareStrings(a.conversationId, b.conversationId)
  );
}

/**
 * A conversation is marked when its last message is from someone else and arrived after the last
 * message the user saw in it, or the user never saw any (architecture, section 4.6).
 */
export function hasNewActivity(
  conversation: Conversation,
  me: string,
  seenSentAt?: number,
): boolean {
  const { lastMessageAt, lastMessageBy } = conversation;
  if (lastMessageAt === undefined || lastMessageBy === undefined || lastMessageBy === me) {
    return false;
  }
  return seenSentAt === undefined || lastMessageAt > seenSentAt;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
