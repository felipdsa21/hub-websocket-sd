// Requests and events of the WebSocket API (architecture, sections 4.1, 4.2 and 4.5).
import { Conversation, ConversationType } from '@/core/model/conversation';
import { HubError } from '@/core/model/error';
import { Message } from '@/core/model/message';
import { UserState } from '@/core/model/user';

export type Action =
  | 'sync'
  | 'heartbeat'
  | 'sendMessage'
  | 'openDirect'
  | 'createGroup'
  | 'addMember'
  | 'leaveGroup'
  | 'getHistory'
  | 'search';

/** A conversation as the backend sends it, with each member's full state. */
export interface ServerConversation {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name?: string;
  readonly members: readonly UserState[];
  readonly lastMessageAt?: number;
  readonly lastMessageBy?: string;
  readonly joinedAt: number;
}

export interface SyncData {
  /** Instant of the request, the `since` of the next `sync` (section 4.4). */
  readonly serverTime: number;
  readonly conversations: readonly ServerConversation[];
  /** Conversations with a message after `since`. */
  readonly updated: readonly string[];
}

/** A page of `getHistory`, in `sk` order (section 4.5). */
export interface HistoryPage {
  readonly messages: readonly Message[];
  readonly hasMore: boolean;
}

/** The answer of `search`: people with a visible direct chat come only as that chat (4.5). */
export interface SearchData {
  readonly conversations: readonly ServerConversation[];
  readonly people: readonly UserState[];
}

/** Events that aren't the answer to a request (including message errors without a matched request). */
export type HubEvent =
  | ({ readonly type: 'message' } & Message)
  | ({ readonly type: 'presence' } & UserState)
  | { readonly type: 'conversationAdded'; readonly conversation: ServerConversation }
  | { readonly type: 'conversationRemoved'; readonly conversationId: string }
  | { readonly type: 'memberJoined'; readonly conversationId: string; readonly member: UserState }
  | { readonly type: 'memberLeft'; readonly conversationId: string; readonly username: string }
  | ({
      readonly type: 'error';
      readonly requestId?: string;
      readonly messageId: string;
    } & HubError);

/** Answers matched to a request by its `requestId`. */
export type ReplyEvent =
  | { readonly type: 'response'; readonly requestId: string; readonly data?: unknown }
  | { readonly type: 'pong'; readonly requestId: string }
  | ({
      readonly type: 'error';
      readonly requestId?: string;
      readonly messageId?: string;
    } & HubError);

/** The client keeps only the usernames in a conversation; the states go to the users store. */
export function toConversation(conversation: ServerConversation): Conversation {
  const { members, ...fields } = conversation;
  return { ...fields, members: members.map((m) => m.username) };
}
