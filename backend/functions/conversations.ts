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
  isValidNameLength,
  parseUsername,
  withConflictRetry,
} from './shared';

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

async function isStillMemberAfterFailure(
  err: unknown,
  conversationId: string,
  username: string,
): Promise<boolean> {
  const members =
    membersFromCancellation(err) ?? toStringSet((await getConversation(conversationId))?.members);
  return members.has(username);
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
          UpdateExpression: 'REMOVE hidden SET joinedAt = :now',
          ConditionExpression: 'attribute_exists(hidden)',
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
  return ctx.reply({ conversation: buildConversationPayload(conv, joinedAt, users) });
}

export async function handleCreateGroup(ctx: RequestContext): Promise<Outcome> {
  const { body, username: me, now } = ctx;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!isValidNameLength(name)) {
    return ctx.fail('invalidRequest', 'name must be 1 to 50 characters.', { field: 'name' });
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
  if (others.length === 0 || others.length + 1 > 99) {
    return ctx.fail('invalidRequest', 'A group must have 1 to 98 other members.', {
      field: 'members',
    });
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
  await fanOut(allMembers, { type: 'conversationAdded', conversation }, users);
  return ctx.reply({ conversation });
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
                ConditionExpression: 'contains(members, :me) AND NOT contains(members, :target)',
                ExpressionAttributeValues: {
                  ':targetSet': new Set([target]),
                  ':me': me,
                  ':target': target,
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
      return (await isStillMemberAfterFailure(err, conversationId, me))
        ? ctx.fail('invalidOperation', 'User is already a member of this group.')
        : ctx.fail('forbidden', 'You are not a member of this conversation.');
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

  await Promise.all([
    fanOut(
      [...updatedMembers].filter((u) => u !== target),
      { type: 'memberJoined', conversationId, member },
      users,
    ),
    fanOut(
      [target],
      { type: 'conversationAdded', conversation: buildConversationPayload(freshConv, now, users) },
      users,
    ),
  ]);
  return ctx.reply({});
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
      return (await isStillMemberAfterFailure(err, conversationId, me))
        ? ctx.fail('lastMember', 'You are the last member of this group; confirm to leave.')
        : ctx.fail('forbidden', 'You are not a member of this conversation.');
    }
    throw err;
  }

  const freshConv = await getConversation(conversationId);
  const remaining = [...toStringSet((freshConv ?? conv).members)].filter((u) => u !== me);
  const users = await getUsers([me, ...remaining]);

  await Promise.all([
    fanOut([me], { type: 'conversationRemoved', conversationId }, users),
    fanOut(remaining, { type: 'memberLeft', conversationId, username: me }, users),
  ]);
  return ctx.reply({});
}

export async function handleSearch(ctx: RequestContext): Promise<Outcome> {
  const { body, username: me } = ctx;
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (query.length === 0) {
    return ctx.fail('invalidRequest', 'query must be a non-empty string.', { field: 'query' });
  }
  const needle = query.toLocaleLowerCase('pt-BR');
  const matches = (value: string) => value.toLocaleLowerCase('pt-BR').includes(needle);

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

  const conversations = visible.filter((c) => {
    if (c.type === 'group') return matches(c.name ?? '');
    const partner = c.members.find((m) => m.username !== me);
    return partner !== undefined && (matches(partner.username) || matches(partner.displayName));
  });

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

  return ctx.reply({ conversations, people });
}
