import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import * as crypto from 'node:crypto';
import {
  ConversationPayload,
  ConversationRecord,
  MembershipRecord,
  RequestContext,
  UserRecord,
  UserState,
  batchGet,
  buildConversationPayload,
  compareConversations,
  directConversationId,
  fanOut,
  getConversation,
  getUsers,
  getVisibleMemberships,
  isValidConversationId,
  membersFromCancellation,
  scanAllUsers,
  table,
  toStringSet,
  toUserState,
} from './data';
import {
  Outcome,
  db,
  isConditionFailure,
  isTransactionConditionFailure,
  isTransactionConflict,
  parseDisplayName,
  parseUsername,
  settle,
  withConflictRetry,
} from './shared';

export const MAX_GROUP_MEMBERS = 99;
export const SEARCH_MAX_RESULTS = 50;

function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

function mapVisibleConversations(
  username: string,
  memberships: MembershipRecord[],
  convById: Map<string, ConversationRecord>,
  users: Map<string, UserRecord>,
) {
  const directPartners = new Set<string>();
  const conversations: ConversationPayload[] = [];

  for (const membership of memberships) {
    const conv = convById.get(membership.conversationId);
    if (!conv) continue;
    if (conv.type === 'direct') {
      const partner = [...toStringSet(conv.members)].find((m) => m !== username) ?? username;
      directPartners.add(partner);
    }
    conversations.push(buildConversationPayload(conv, membership.joinedAt ?? 0, users));
  }
  conversations.sort(compareConversations);
  return { conversations, directPartners };
}

async function loadVisibleConversations(username: string): Promise<ConversationPayload[]> {
  const memberships = await getVisibleMemberships(username);
  if (memberships.length === 0) return [];

  const convRecords = await batchGet<ConversationRecord>(
    table('CONVERSATIONS_TABLE'),
    memberships.map((m) => ({ conversationId: m.conversationId })),
  );
  const memberNames = new Set(convRecords.flatMap((c) => [...toStringSet(c.members)]));
  const users = await getUsers(memberNames);
  const convById = new Map(convRecords.map((c) => [c.conversationId, c]));

  return mapVisibleConversations(username, memberships, convById, users).conversations;
}

/**
 * Replies after the fan-out of a committed change. When the fan-out fails, the requester still gets the
 * reply, since a retry would repeat the committed write, and the failure is rethrown so the request logs it.
 */
async function replyAfterFanOut(
  ctx: RequestContext,
  delivery: Promise<unknown>,
  data: object,
): Promise<Outcome> {
  try {
    await delivery;
  } catch (err) {
    await ctx.reply(data);
    throw err;
  }
  return ctx.reply(data);
}

async function requireGroupMember(
  ctx: RequestContext,
  conversationId: unknown,
): Promise<ConversationRecord | Outcome> {
  if (!isValidConversationId(conversationId)) {
    return ctx.fail('invalidRequest', 'conversationId is invalid.', { field: 'conversationId' });
  }
  const conv = await getConversation(conversationId);
  if (!conv || !toStringSet(conv.members).has(ctx.username)) {
    return ctx.fail('forbidden', 'You are not a member of this conversation.');
  }
  if (conv.type !== 'group') {
    return ctx.fail('invalidOperation', 'This action is only allowed in group conversations.');
  }
  return conv;
}

async function membersAfterFailure(err: unknown, conversationId: string): Promise<Set<string>> {
  return (
    membersFromCancellation(err) ?? toStringSet((await getConversation(conversationId))?.members)
  );
}

async function revealCallerMembership(
  me: string,
  conversationId: string,
  now: number,
): Promise<number> {
  try {
    const { Attributes } = await withConflictRetry(() =>
      db.send(
        new UpdateCommand({
          TableName: table('MEMBERSHIPS_TABLE'),
          Key: { username: me, conversationId },
          UpdateExpression: 'REMOVE #hidden SET joinedAt = :now',
          ConditionExpression: 'attribute_exists(#hidden)',
          ExpressionAttributeNames: { '#hidden': 'hidden' },
          ExpressionAttributeValues: { ':now': now },
          ReturnValues: 'ALL_NEW',
        }),
      ),
    );
    return (Attributes as MembershipRecord | undefined)?.joinedAt ?? now;
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
    const { Item } = await db.send(
      new GetCommand({
        TableName: table('MEMBERSHIPS_TABLE'),
        Key: { username: me, conversationId },
        ConsistentRead: true,
      }),
    );
    return (Item as MembershipRecord | undefined)?.joinedAt ?? now;
  }
}

export async function handleSync(ctx: RequestContext): Promise<Outcome> {
  const { since } = ctx.body;
  if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since) || since < 0)) {
    return ctx.fail('invalidRequest', 'since must be a non-negative number.', { field: 'since' });
  }
  const conversations = await loadVisibleConversations(ctx.username);
  const updated =
    since === undefined
      ? []
      : conversations
          .filter((c) => c.lastMessageAt !== undefined && c.lastMessageAt > since)
          .map((c) => c.conversationId);

  return ctx.reply({ serverTime: ctx.now, conversations, updated });
}

export async function handleOpenDirect(ctx: RequestContext): Promise<Outcome> {
  const { body, username: me, now } = ctx;
  const target = parseUsername(body.username);
  if (!target) {
    return ctx.fail('invalidRequest', 'username is invalid.', { field: 'username' });
  }
  if (target === me) {
    return ctx.fail('invalidOperation', 'Cannot open a direct chat with yourself.');
  }
  if (!(await getUsers([target])).has(target)) {
    return ctx.fail('notFound', 'User not found.', { usernames: [target] });
  }

  const conversationId = directConversationId(me, target);
  let conv: ConversationRecord = {
    conversationId,
    type: 'direct',
    members: new Set([me, target]),
    started: false,
  };
  let joinedAt = now;

  try {
    await withConflictRetry(() =>
      db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table('CONVERSATIONS_TABLE'),
                Item: conv,
                ConditionExpression: 'attribute_not_exists(conversationId)',
              },
            },
            {
              Put: {
                TableName: table('MEMBERSHIPS_TABLE'),
                Item: { username: me, conversationId, joinedAt: now },
              },
            },
            {
              Put: {
                TableName: table('MEMBERSHIPS_TABLE'),
                Item: { username: target, conversationId, hidden: true },
              },
            },
          ],
        }),
      ),
    );
  } catch (err) {
    if (isTransactionConflict(err)) {
      return ctx.fail('conflict', 'Transaction conflict; retry the request.');
    }
    if (!isTransactionConditionFailure(err)) throw err;
    try {
      joinedAt = await revealCallerMembership(me, conversationId, now);
    } catch (revealErr) {
      if (isTransactionConflict(revealErr)) {
        return ctx.fail('conflict', 'Transaction conflict; retry the request.');
      }
      throw revealErr;
    }
    conv = (await getConversation(conversationId)) ?? conv;
  }

  // Read member states after writing membership so subsequent presence changes are never missed (architecture, section 4.2).
  const users = await getUsers([me, target]);
  const outcome = await ctx.reply({
    conversation: buildConversationPayload(conv, joinedAt, users),
  });
  return { ...outcome, conversationId: conv.conversationId };
}

export async function handleCreateGroup(ctx: RequestContext): Promise<Outcome> {
  const { body, username: me, now } = ctx;
  const name = parseDisplayName(body.name);
  if (!name) {
    return ctx.fail('invalidRequest', 'name must be 1 to 50 valid characters.', { field: 'name' });
  }
  if (!Array.isArray(body.members)) {
    return ctx.fail('invalidRequest', 'members must be an array of usernames.', {
      field: 'members',
    });
  }
  const normalized: string[] = [];
  for (const item of body.members) {
    const candidate = parseUsername(item);
    if (!candidate) {
      return ctx.fail('invalidRequest', 'members contains an invalid username.', {
        field: 'members',
      });
    }
    normalized.push(candidate);
  }
  const others = [...new Set(normalized.filter((u) => u !== me))];
  if (others.length === 0 || others.length + 1 > MAX_GROUP_MEMBERS) {
    return ctx.fail(
      'invalidRequest',
      `A group must have 1 to ${MAX_GROUP_MEMBERS - 1} other members.`,
      {
        field: 'members',
      },
    );
  }

  const existing = await getUsers(others);
  const missing = others.filter((u) => !existing.has(u));
  if (missing.length > 0) {
    return ctx.fail('notFound', 'One or more users do not exist.', { usernames: missing });
  }

  const allMembers = [me, ...others];
  const conversationId = `g:${crypto.randomUUID()}`;
  const conv: ConversationRecord = {
    conversationId,
    type: 'group',
    name,
    members: new Set(allMembers),
  };

  try {
    await withConflictRetry(() =>
      db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table('CONVERSATIONS_TABLE'),
                Item: conv,
                ConditionExpression: 'attribute_not_exists(conversationId)',
              },
            },
            ...allMembers.map((username) => ({
              Put: {
                TableName: table('MEMBERSHIPS_TABLE'),
                Item: { username, conversationId, joinedAt: now },
                ConditionExpression: 'attribute_not_exists(conversationId)',
              },
            })),
          ],
        }),
      ),
    );
  } catch (err) {
    if (isTransactionConflict(err)) {
      return ctx.fail('conflict', 'Transaction conflict; retry the request.');
    }
    throw err;
  }

  const users = await getUsers(allMembers);
  const conversation = buildConversationPayload(conv, now, users);
  const outcome = await replyAfterFanOut(
    ctx,
    fanOut(allMembers, { type: 'conversationAdded', conversation }, users),
    { conversation },
  );
  return { ...outcome, conversationId: conv.conversationId };
}

export async function handleAddMember(ctx: RequestContext): Promise<Outcome> {
  const { body, username: me, now } = ctx;
  const target = parseUsername(body.username);
  if (!target) {
    return ctx.fail('invalidRequest', 'username is invalid.', { field: 'username' });
  }
  const conv = await requireGroupMember(ctx, body.conversationId);
  if ('result' in conv) return conv;

  const { conversationId } = conv;
  const previousMembers = toStringSet(conv.members);
  if (previousMembers.has(target)) {
    return ctx.fail('invalidOperation', 'User is already a member of this group.');
  }
  if (previousMembers.size >= MAX_GROUP_MEMBERS) {
    return ctx.fail(
      'invalidOperation',
      `Group has reached the maximum of ${MAX_GROUP_MEMBERS} members.`,
    );
  }
  if (!(await getUsers([target])).has(target)) {
    return ctx.fail('notFound', 'User not found.', { usernames: [target] });
  }

  try {
    await withConflictRetry(() =>
      db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: table('CONVERSATIONS_TABLE'),
                Key: { conversationId },
                UpdateExpression: 'ADD members :targetSet',
                ConditionExpression:
                  'contains(members, :me) AND NOT contains(members, :target) AND size(members) < :maxMembers',
                ExpressionAttributeValues: {
                  ':targetSet': new Set([target]),
                  ':me': me,
                  ':target': target,
                  ':maxMembers': MAX_GROUP_MEMBERS,
                },
                ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
              },
            },
            {
              Put: {
                TableName: table('MEMBERSHIPS_TABLE'),
                Item: { username: target, conversationId, joinedAt: now },
                ConditionExpression: 'attribute_not_exists(conversationId)',
              },
            },
          ],
        }),
      ),
    );
  } catch (err) {
    if (isTransactionConflict(err)) {
      return ctx.fail('conflict', 'Transaction conflict; retry the request.');
    }
    if (isTransactionConditionFailure(err)) {
      const members = await membersAfterFailure(err, conversationId);
      if (!members.has(me)) {
        return ctx.fail('forbidden', 'You are not a member of this conversation.');
      }
      if (members.has(target)) {
        return ctx.fail('invalidOperation', 'User is already a member of this group.');
      }
      return ctx.fail(
        'invalidOperation',
        `Group has reached the maximum of ${MAX_GROUP_MEMBERS} members.`,
      );
    }
    throw err;
  }

  const freshConv = (await getConversation(conversationId)) ?? {
    ...conv,
    members: new Set([...previousMembers, target]),
  };
  const updatedMembers = toStringSet(freshConv.members);
  const users = await getUsers(updatedMembers);
  const member = toUserState(users.get(target), target);

  return replyAfterFanOut(
    ctx,
    settle([
      fanOut(
        [...updatedMembers].filter((u) => u !== target),
        { type: 'memberJoined', conversationId, member },
        users,
      ),
      fanOut(
        [target],
        {
          type: 'conversationAdded',
          conversation: buildConversationPayload(freshConv, now, users),
        },
        users,
      ),
    ]),
    {},
  );
}

export async function handleLeaveGroup(ctx: RequestContext): Promise<Outcome> {
  const { body, username: me } = ctx;
  if (body.confirm !== undefined && typeof body.confirm !== 'boolean') {
    return ctx.fail('invalidRequest', 'confirm must be a boolean.', { field: 'confirm' });
  }
  const conv = await requireGroupMember(ctx, body.conversationId);
  if ('result' in conv) return conv;

  const { conversationId } = conv;
  const confirm = body.confirm === true;
  const condition = confirm
    ? 'contains(members, :me)'
    : 'contains(members, :me) AND size(members) > :one';
  const values: Record<string, unknown> = { ':meSet': new Set([me]), ':me': me };
  if (!confirm) values[':one'] = 1;

  try {
    await withConflictRetry(() =>
      db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: table('CONVERSATIONS_TABLE'),
                Key: { conversationId },
                UpdateExpression: 'DELETE members :meSet',
                ConditionExpression: condition,
                ExpressionAttributeValues: values,
                ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
              },
            },
            {
              Delete: {
                TableName: table('MEMBERSHIPS_TABLE'),
                Key: { username: me, conversationId },
                ConditionExpression: 'attribute_exists(conversationId)',
              },
            },
          ],
        }),
      ),
    );
  } catch (err) {
    if (isTransactionConflict(err)) {
      return ctx.fail('conflict', 'Transaction conflict; retry the request.');
    }
    if (isTransactionConditionFailure(err)) {
      return (await membersAfterFailure(err, conversationId)).has(me)
        ? ctx.fail('lastMember', 'You are the last member of this group; confirm to leave.')
        : ctx.fail('forbidden', 'You are not a member of this conversation.');
    }
    throw err;
  }

  const freshConv = await getConversation(conversationId);
  const remaining = [...toStringSet((freshConv ?? conv).members)].filter((u) => u !== me);
  const users = await getUsers([me, ...remaining]);

  return replyAfterFanOut(
    ctx,
    settle([
      fanOut([me], { type: 'conversationRemoved', conversationId }, users),
      fanOut(remaining, { type: 'memberLeft', conversationId, username: me }, users),
    ]),
    {},
  );
}

export async function handleSearch(ctx: RequestContext): Promise<Outcome> {
  const { body, username: me } = ctx;
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  const needle = normalizeSearch(query);
  if (needle.length === 0) {
    return ctx.fail('invalidRequest', 'query must be a non-empty string.', { field: 'query' });
  }
  const matches = (value: string) => normalizeSearch(value).includes(needle);

  const memberships = await getVisibleMemberships(me);
  const [convRecords, allUsers] = await Promise.all([
    memberships.length > 0
      ? batchGet<ConversationRecord>(
          table('CONVERSATIONS_TABLE'),
          memberships.map((m) => ({ conversationId: m.conversationId })),
        )
      : Promise.resolve([] as ConversationRecord[]),
    scanAllUsers(),
  ]);

  const convById = new Map(convRecords.map((c) => [c.conversationId, c]));
  const { conversations: visible, directPartners } = mapVisibleConversations(
    me,
    memberships,
    convById,
    allUsers,
  );

  const conversations = visible
    .filter((c) => {
      if (c.type === 'group') return matches(c.name ?? '');
      const partner = c.members.find((m) => m.username !== me);
      return partner !== undefined && (matches(partner.username) || matches(partner.displayName));
    })
    .slice(0, SEARCH_MAX_RESULTS);

  const people: UserState[] = [];
  for (const user of allUsers.values()) {
    if (user.username === me || directPartners.has(user.username)) continue;
    if (matches(user.username) || matches(user.displayName)) {
      people.push(toUserState(user, user.username));
    }
  }
  people.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName, 'pt-BR') ||
      (a.username < b.username ? -1 : a.username > b.username ? 1 : 0),
  );

  return ctx.reply({ conversations, people: people.slice(0, SEARCH_MAX_RESULTS) });
}
