export type ConversationType = 'direct' | 'group';

/**
 * A conversation as the client keeps it. The backend sends each member's full state; the client
 * keeps only the usernames here and the states in the users store.
 */
export interface Conversation {
  readonly conversationId: string;
  readonly type: ConversationType;
  /** Group name; absent in direct chats. */
  readonly name?: string;
  readonly members: readonly string[];
  readonly lastMessageAt?: number;
  readonly lastMessageBy?: string;
  /** When the conversation became visible to the user (RF10). */
  readonly joinedAt: number;
}

export function directConversationId(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `d:${first}:${second}`;
}
