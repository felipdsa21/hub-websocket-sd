import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ConversationRecord,
  MembershipRecord,
  MessageRecord,
  RequestContext,
  batchGet,
  buildConversationPayload,
  fanOut,
  getConversation,
  getUsers,
  isValidConversationId,
  table,
  toStringSet,
} from './data';
import {
  Outcome,
  UUID,
  db,
  getCancellationReasons,
  isConditionFailure,
  isTransactionConditionFailure,
  isTransactionConflict,
  send,
  withConflictRetry,
} from './shared';

const HISTORY_MAX_MESSAGES = 50;
export const HISTORY_MAX_BYTES = 28 * 1024;
// Without this cap, another client could store a message near 128 KB whose history page would exceed the @connections limit (RF11).
export const MAX_TEXT_BYTES = 32 * 1024;
// Idempotency markers are only needed for short-term resends; messages themselves never expire (architecture, section 3.3).
export const MARKER_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SendMessageInput {
  conversationId: string;
  messageId: string;
  text: string;
}

// The shape messageSk produces; history cursors must match it so they stay within DynamoDB's key size.
const MESSAGE_SK =
  /^m#\d{13}#[a-z0-9._-]{3,32}#[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// An instant alone sorts before every message sent at it; `after` accepts it to resume from a time.
const INSTANT_SK = /^m#\d{13}#$/;

function messageSk(sentAt: number, sender: string, messageId: string): string {
  return `m#${String(sentAt).padStart(13, '0')}#${sender}#${messageId}`;
}

function markerSk(sender: string, messageId: string): string {
  return `id#${sender}#${messageId}`;
}

function toMessageEvent(msg: MessageRecord) {
  return {
    type: 'message',
    conversationId: msg.conversationId,
    sk: msg.sk,
    messageId: msg.messageId,
    sender: msg.sender,
    text: msg.text,
    sentAt: msg.sentAt,
  };
}

async function parseSendMessageInput(ctx: RequestContext): Promise<SendMessageInput | Outcome> {
  const { body } = ctx;
  const rawMessageId =
    typeof body.messageId === 'string' && body.messageId ? body.messageId : undefined;
  if (typeof body.messageId !== 'string' || !UUID.test(body.messageId)) {
    return ctx.fail(
      'invalidRequest',
      'messageId must be a UUID v4.',
      { field: 'messageId' },
      rawMessageId,
    );
  }
  if (!isValidConversationId(body.conversationId)) {
    return ctx.fail(
      'invalidRequest',
      'conversationId is invalid.',
      { field: 'conversationId' },
      body.messageId,
    );
  }
  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return ctx.fail(
      'invalidRequest',
      'text must be a non-empty string.',
      { field: 'text' },
      body.messageId,
    );
  }
  if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES) {
    return ctx.fail(
      'invalidRequest',
      'text exceeds the maximum allowed size.',
      { field: 'text' },
      body.messageId,
    );
  }
  return { conversationId: body.conversationId, messageId: body.messageId, text: body.text };
}

/** Updates conversation summary outside the message transaction to avoid write contention (R06, T8). */
async function updateLastMessage(conversationId: string, sentAt: number, sender: string) {
  try {
    await withConflictRetry(() =>
      db.send(
        new UpdateCommand({
          TableName: table('CONVERSATIONS_TABLE'),
          Key: { conversationId },
          UpdateExpression: 'SET lastMessageAt = :sentAt, lastMessageBy = :sender',
          ConditionExpression:
            'attribute_not_exists(lastMessageAt) OR lastMessageAt < :sentAt OR (lastMessageAt = :sentAt AND lastMessageBy < :sender)',
          ExpressionAttributeValues: { ':sentAt': sentAt, ':sender': sender },
        }),
      ),
    );
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
}

/** Reveals hidden memberships on the first message of a direct chat before delivering the message (D11, RF10). */
async function revealHiddenMemberships(conv: ConversationRecord, joinedAt: number) {
  if (conv.started !== false) return;
  const memberships = await batchGet<MembershipRecord>(
    table('MEMBERSHIPS_TABLE'),
    [...toStringSet(conv.members)].map((username) => ({
      username,
      conversationId: conv.conversationId,
    })),
  );
  const revealed: string[] = [];
  for (const membership of memberships) {
    if (!membership.hidden) continue;
    try {
      await withConflictRetry(() =>
        db.send(
          new UpdateCommand({
            TableName: table('MEMBERSHIPS_TABLE'),
            Key: { username: membership.username, conversationId: conv.conversationId },
            UpdateExpression: 'REMOVE #hidden SET joinedAt = :joinedAt',
            ConditionExpression: 'attribute_exists(#hidden)',
            ExpressionAttributeNames: { '#hidden': 'hidden' },
            ExpressionAttributeValues: { ':joinedAt': joinedAt },
          }),
        ),
      );
      revealed.push(membership.username);
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }
  await withConflictRetry(() =>
    db.send(
      new UpdateCommand({
        TableName: table('CONVERSATIONS_TABLE'),
        Key: { conversationId: conv.conversationId },
        UpdateExpression: 'SET #started = :true',
        ConditionExpression: 'attribute_exists(conversationId)',
        ExpressionAttributeNames: { '#started': 'started' },
        ExpressionAttributeValues: { ':true': true },
      }),
    ),
  ).catch((err) => {
    if (!isConditionFailure(err)) throw err;
  });

  if (revealed.length > 0) {
    const freshConv = (await getConversation(conv.conversationId)) ?? conv;
    const users = await getUsers(toStringSet(freshConv.members));
    const payload = buildConversationPayload(freshConv, joinedAt, users);
    await fanOut(revealed, { type: 'conversationAdded', conversation: payload }, users);
  }
}

/** Runs post-transaction summary and visibility updates; false when a persistent conflict must keep the message queued. */
async function finalizeMessageState(
  conv: ConversationRecord,
  sentAt: number,
  sender: string,
): Promise<boolean> {
  try {
    await updateLastMessage(conv.conversationId, sentAt, sender);
    await revealHiddenMemberships(conv, sentAt);
    return true;
  } catch (err) {
    if (isTransactionConflict(err)) return false;
    throw err;
  }
}

async function readMarkerRef(
  conversationId: string,
  sender: string,
  messageId: string,
): Promise<string | undefined> {
  const { Item } = await db.send(
    new GetCommand({
      TableName: table('MESSAGES_TABLE'),
      Key: { conversationId, sk: markerSk(sender, messageId) },
      ConsistentRead: true,
    }),
  );
  return typeof Item?.ref === 'string' ? Item.ref : undefined;
}

async function handleResend(
  ctx: RequestContext,
  conv: ConversationRecord,
  existingRef: string,
): Promise<Outcome> {
  const { Item } = await db.send(
    new GetCommand({
      TableName: table('MESSAGES_TABLE'),
      Key: { conversationId: conv.conversationId, sk: existingRef },
      ConsistentRead: true,
    }),
  );
  if (!Item) {
    throw new Error('Missing message referenced by idempotency marker');
  }
  const msg = Item as MessageRecord;
  if (!(await finalizeMessageState(conv, msg.sentAt, msg.sender))) {
    return { result: 'error', code: 'conflict' };
  }
  const delivered = await send(ctx.connectionId, ctx.username, toMessageEvent(msg));
  return { result: delivered ? 'duplicate' : 'gone', conversationId: conv.conversationId };
}

async function persistMessage(
  markerKey: string,
  message: MessageRecord,
): Promise<'created' | 'duplicate' | 'conflict'> {
  try {
    await withConflictRetry(() =>
      db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table('MESSAGES_TABLE'),
                Item: {
                  conversationId: message.conversationId,
                  sk: markerKey,
                  ref: message.sk,
                  expiresAt: Math.floor(message.sentAt / 1000) + MARKER_TTL_SECONDS,
                },
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
            {
              Put: {
                TableName: table('MESSAGES_TABLE'),
                Item: message,
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
          ],
        }),
      ),
    );
    return 'created';
  } catch (err) {
    if (isTransactionConditionFailure(err)) {
      if (getCancellationReasons(err)?.[0]?.Code === 'ConditionalCheckFailed') return 'duplicate';
      throw err;
    }
    if (isTransactionConflict(err)) return 'conflict';
    throw err;
  }
}

export async function handleSendMessage(ctx: RequestContext): Promise<Outcome> {
  const parsed = await parseSendMessageInput(ctx);
  if ('result' in parsed) return parsed;
  const { conversationId, messageId, text } = parsed;
  const { username: sender, now } = ctx;

  const conv = await getConversation(conversationId);
  if (!conv || !toStringSet(conv.members).has(sender)) {
    return ctx.fail(
      'forbidden',
      'You are not a member of this conversation.',
      undefined,
      messageId,
    );
  }

  const sk = messageSk(now, sender, messageId);
  const message: MessageRecord = { conversationId, sk, messageId, sender, text, sentAt: now };
  const status = await persistMessage(markerSk(sender, messageId), message);

  if (status !== 'created') {
    const ref = await readMarkerRef(conversationId, sender, messageId);
    if (ref) return handleResend(ctx, conv, ref);
    if (status === 'conflict') {
      // Returning an error would drop the message from the client queue even though a racing write may succeed (RF12).
      return { result: 'error', code: 'conflict' };
    }
    throw new Error(`Missing idempotency marker after condition failure for ${messageId}`);
  }

  if (!(await finalizeMessageState(conv, now, sender))) {
    return { result: 'error', code: 'conflict' };
  }

  const freshConv = (await getConversation(conversationId)) ?? conv;
  const delivered = await fanOut(
    toStringSet(freshConv.members),
    toMessageEvent(message),
    undefined,
    ctx.connectionId,
  );
  return { result: delivered ? 'ok' : 'gone' };
}

function buildHistoryQuery(conversationId: string, before?: string, after?: string) {
  if (before !== undefined) {
    return {
      KeyConditionExpression: 'conversationId = :cid AND sk BETWEEN :mPrefix AND :before',
      ExpressionAttributeValues: { ':cid': conversationId, ':mPrefix': 'm#', ':before': before },
      ScanIndexForward: false,
      Limit: HISTORY_MAX_MESSAGES + 2,
    };
  }
  if (after !== undefined) {
    return {
      KeyConditionExpression: 'conversationId = :cid AND sk BETWEEN :after AND :mEnd',
      ExpressionAttributeValues: { ':cid': conversationId, ':after': after, ':mEnd': 'm$' },
      ScanIndexForward: true,
      Limit: HISTORY_MAX_MESSAGES + 2,
    };
  }
  return {
    KeyConditionExpression: 'conversationId = :cid AND begins_with(sk, :mPrefix)',
    ExpressionAttributeValues: { ':cid': conversationId, ':mPrefix': 'm#' },
    ScanIndexForward: false,
    Limit: HISTORY_MAX_MESSAGES + 1,
  };
}

function sliceHistoryPage(items: MessageRecord[], cursor: string | undefined) {
  const messages: MessageRecord[] = [];
  let usedBytes = 0;
  let truncated = false;

  for (const item of items) {
    if (item.sk === cursor) continue;
    const msg: MessageRecord = {
      conversationId: item.conversationId,
      sk: item.sk,
      messageId: item.messageId,
      sender: item.sender,
      text: item.text,
      sentAt: item.sentAt,
    };
    const itemBytes = Buffer.byteLength(JSON.stringify(msg)) + (messages.length > 0 ? 1 : 0);
    if (
      messages.length >= HISTORY_MAX_MESSAGES ||
      (messages.length > 0 && usedBytes + itemBytes > HISTORY_MAX_BYTES)
    ) {
      truncated = true;
      break;
    }
    messages.push(msg);
    usedBytes += itemBytes;
  }

  return { messages, truncated };
}

export async function handleGetHistory(ctx: RequestContext): Promise<Outcome> {
  const { body, username } = ctx;
  if (!isValidConversationId(body.conversationId)) {
    return ctx.fail('invalidRequest', 'conversationId is invalid.', { field: 'conversationId' });
  }
  const { before, after } = body;
  if (before !== undefined && after !== undefined) {
    return ctx.fail('invalidRequest', 'before and after cannot be used together.', {
      field: 'before',
    });
  }
  if (before !== undefined && (typeof before !== 'string' || !MESSAGE_SK.test(before))) {
    return ctx.fail('invalidRequest', 'before must be a message sort key.', { field: 'before' });
  }
  if (
    after !== undefined &&
    (typeof after !== 'string' || !(MESSAGE_SK.test(after) || INSTANT_SK.test(after)))
  ) {
    return ctx.fail(
      'invalidRequest',
      'after must be a message sort key or an instant (m#<13 digits>#).',
      { field: 'after' },
    );
  }

  const conv = await getConversation(body.conversationId);
  if (!conv || !toStringSet(conv.members).has(username)) {
    return ctx.fail('forbidden', 'You are not a member of this conversation.');
  }

  const query = buildHistoryQuery(body.conversationId, before, after);
  const result = await db.send(
    new QueryCommand({
      TableName: table('MESSAGES_TABLE'),
      ConsistentRead: true,
      ...query,
    }),
  );

  const { messages, truncated } = sliceHistoryPage(
    (result.Items ?? []) as MessageRecord[],
    before ?? after,
  );
  if (!query.ScanIndexForward) {
    messages.reverse();
  }

  return ctx.reply({
    messages,
    hasMore: truncated || result.LastEvaluatedKey !== undefined,
  });
}
