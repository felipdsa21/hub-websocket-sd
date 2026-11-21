import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  ErrorCode,
  ErrorDetails,
  Outcome,
  PresenceUserRecord,
  USERNAME,
  UUID,
  batchGet,
  db,
  getCancellationReasons,
  send,
  settle,
  toStringSet,
} from './shared';

export { batchGet, toStringSet };

export interface UserState {
  username: string;
  displayName: string;
  online: boolean;
  version: number;
}

export type UserRecord = PresenceUserRecord;

export interface ConversationRecord {
  conversationId: string;
  type: 'direct' | 'group';
  name?: string;
  members: Set<string> | string[];
  started?: boolean;
  lastMessageAt?: number;
  lastMessageBy?: string;
}

export interface MembershipRecord {
  username: string;
  conversationId: string;
  hidden?: boolean;
  joinedAt?: number;
}

export interface MessageRecord {
  conversationId: string;
  sk: string;
  messageId: string;
  sender: string;
  text: string;
  sentAt: number;
}

export interface ConversationPayload {
  conversationId: string;
  type: 'direct' | 'group';
  name?: string;
  members: UserState[];
  lastMessageAt?: number;
  lastMessageBy?: string;
  joinedAt: number;
}

export interface RequestContext {
  connectionId: string;
  username: string;
  requestId: string;
  now: number;
  body: Record<string, unknown>;
  fail: (
    code: ErrorCode,
    message: string,
    details?: ErrorDetails,
    messageId?: string,
  ) => Promise<Outcome>;
  reply: (data: object) => Promise<Outcome>;
}

export const table = (envKey: string) => process.env[envKey] ?? envKey;

export function directConversationId(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `d:${first}:${second}`;
}

/** Validates direct (`d:<u1>:<u2>`) and group (`g:<uuid>`) identifiers (architecture, section 3.1). */
export function isValidConversationId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.startsWith('d:')) {
    const parts = id.split(':');
    return (
      parts.length === 3 &&
      USERNAME.test(parts[1] ?? '') &&
      USERNAME.test(parts[2] ?? '') &&
      (parts[1] ?? '') < (parts[2] ?? '')
    );
  }
  if (id.startsWith('g:')) {
    return UUID.test(id.slice(2));
  }
  return false;
}

export function toUserState(record: UserRecord | undefined, fallbackUsername: string): UserState {
  if (!record) {
    return { username: fallbackUsername, displayName: fallbackUsername, online: false, version: 0 };
  }
  return {
    username: record.username,
    displayName: record.displayName,
    online: toStringSet(record.connections).size > 0,
    version: record.version,
  };
}

export async function getConversation(
  conversationId: string,
): Promise<ConversationRecord | undefined> {
  const { Item } = await db.send(
    new GetCommand({
      TableName: table('CONVERSATIONS_TABLE'),
      Key: { conversationId },
      ConsistentRead: true,
    }),
  );
  return Item as ConversationRecord | undefined;
}

export async function getUsers(usernames: Iterable<string>): Promise<Map<string, UserRecord>> {
  const unique = [...new Set(usernames)];
  const map = new Map<string, UserRecord>();
  if (unique.length === 0) return map;
  const items = await batchGet<UserRecord>(
    table('USERS_TABLE'),
    unique.map((username) => ({ username })),
  );
  for (const item of items) {
    map.set(item.username, item);
  }
  return map;
}

export async function scanAllUsers(): Promise<Map<string, UserRecord>> {
  const map = new Map<string, UserRecord>();
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await db.send(
      new ScanCommand({
        TableName: table('USERS_TABLE'),
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of (Items ?? []) as UserRecord[]) {
      map.set(item.username, item);
    }
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return map;
}

export async function getVisibleMemberships(username: string): Promise<MembershipRecord[]> {
  const visible: MembershipRecord[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await db.send(
      new QueryCommand({
        TableName: table('MEMBERSHIPS_TABLE'),
        KeyConditionExpression: 'username = :username',
        ExpressionAttributeValues: { ':username': username },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of (Items ?? []) as MembershipRecord[]) {
      if (!item.hidden) visible.push(item);
    }
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return visible;
}

export function buildConversationPayload(
  conv: ConversationRecord,
  joinedAt: number,
  users: Map<string, UserRecord>,
): ConversationPayload {
  const members = [...toStringSet(conv.members)]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((u) => toUserState(users.get(u), u));

  return {
    conversationId: conv.conversationId,
    type: conv.type,
    ...(conv.name !== undefined && { name: conv.name }),
    members,
    ...(conv.lastMessageAt !== undefined && { lastMessageAt: conv.lastMessageAt }),
    ...(conv.lastMessageBy !== undefined && { lastMessageBy: conv.lastMessageBy }),
    joinedAt,
  };
}

/** Matches the client conversation list order: empty chats first by joinedAt desc, then by lastMessageAt desc (RF10). */
export function compareConversations(a: ConversationPayload, b: ConversationPayload): number {
  const idOrder =
    a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0;
  if (a.lastMessageAt === undefined || b.lastMessageAt === undefined) {
    if (a.lastMessageAt !== b.lastMessageAt) {
      return a.lastMessageAt === undefined ? -1 : 1;
    }
    return b.joinedAt - a.joinedAt || idOrder;
  }
  const byA = a.lastMessageBy ?? '';
  const byB = b.lastMessageBy ?? '';
  const byOrder = byB < byA ? -1 : byB > byA ? 1 : 0;
  return b.lastMessageAt - a.lastMessageAt || byOrder || idOrder;
}

/** Extracts `members` from a DynamoDB TransactionCanceledException failure item (raw AttributeValue format). */
export function membersFromCancellation(err: unknown): Set<string> | undefined {
  const item = getCancellationReasons(err)?.[0]?.Item as
    Record<string, { SS?: string[] } | Set<string> | string[]> | undefined;
  if (!item) return undefined;
  const raw = item.members;
  if (!raw) return new Set();
  if (raw instanceof Set || Array.isArray(raw)) return toStringSet(raw);
  if (typeof raw === 'object' && Array.isArray(raw.SS)) return new Set(raw.SS);
  return new Set();
}

/**
 * Broadcasts an event to every connection of the given users, e.g. the members of a conversation.
 * A 410 Gone unbinds that connection only (RF08); any other failure is rethrown after all deliveries finish.
 */
export async function fanOut(
  usernames: Iterable<string>,
  event: object,
  preloadedUsers?: Map<string, UserRecord>,
  trackConnectionId?: string,
): Promise<boolean> {
  const unique = [...new Set(usernames)];
  if (unique.length === 0) return !trackConnectionId;
  const users = preloadedUsers ?? (await getUsers(unique));
  const deliveries: Promise<{ connId: string; delivered: boolean }>[] = [];
  for (const username of unique) {
    const user = users.get(username);
    if (!user) continue;
    for (const connId of toStringSet(user.connections)) {
      deliveries.push(send(connId, username, event).then((delivered) => ({ connId, delivered })));
    }
  }
  const results = await settle(deliveries);
  if (!trackConnectionId) return true;
  return results.some((r) => r.connId === trackConnectionId && r.delivered);
}
