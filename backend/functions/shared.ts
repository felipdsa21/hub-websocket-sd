import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { createHmac } from 'node:crypto';

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
/** The name of a DynamoDB table, failing when its environment variable is missing. */
export function table(envKey: string): string {
  const name = process.env[envKey];
  if (!name) throw new Error(`Missing environment variable ${envKey}`);
  return name;
}

export const api = new ApiGatewayManagementApiClient({ endpoint: process.env.CALLBACK_URL });
export const ssm = new SSMClient({});

// A connection id enters Users.connections before the handshake ends, and a postToConnection in that window also answers 410.
const HANDSHAKE_GRACE_MS = 30_000;
// Wait 1 minute before re-announcing stale presence so an in-flight Lambda is not duplicated (section 3.5).
export const REANNOUNCE_DELAY_MS = 60_000;

export interface PresenceUserRecord {
  username: string;
  displayName: string;
  connections?: Set<string> | string[];
  version: number;
  changedAt?: number;
  announcedVersion?: number;
}

export function toStringSet(value: unknown): Set<string> {
  if (value instanceof Set) return new Set(Array.from(value, String));
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set();
}

export async function batchGet<T>(
  tableName: string,
  keys: Record<string, unknown>[],
): Promise<T[]> {
  const items: T[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    let pending: Record<string, unknown>[] | undefined = keys.slice(i, i + 100);
    for (let attempt = 0; pending && pending.length > 0; attempt++) {
      const res = await db.send(
        new BatchGetCommand({
          RequestItems: { [tableName]: { Keys: pending, ConsistentRead: true } },
        }),
      );
      const responses = res?.Responses;
      if (responses?.[tableName]) {
        items.push(...(responses[tableName] as T[]));
      }
      pending = res?.UnprocessedKeys?.[tableName]?.Keys as Record<string, unknown>[] | undefined;
      if (pending && pending.length > 0) {
        if (attempt >= 5) {
          throw new Error(`BatchGet exhausted retries on ${tableName}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 15 * 2 ** attempt));
      }
    }
  }
  return items;
}

export type ErrorCode =
  | 'invalidRequest'
  | 'unknownAction'
  | 'forbidden'
  | 'notFound'
  | 'invalidOperation'
  | 'conflict'
  | 'notRegistered'
  | 'lastMember';

export interface ErrorDetails {
  field?: string;
  usernames?: string[];
}

export const isConditionFailure = (err: unknown) =>
  (err as Error).name === 'ConditionalCheckFailedException';

export function getCancellationReasons(err: unknown) {
  if ((err as Error).name !== 'TransactionCanceledException') return undefined;
  return (err as TransactionCanceledException).CancellationReasons;
}

export function isTransactionConditionFailure(err: unknown): boolean {
  const reasons = getCancellationReasons(err);
  return Boolean(reasons?.some((r) => r.Code === 'ConditionalCheckFailed'));
}

export function isTransactionConflict(err: unknown): boolean {
  if ((err as Error).name === 'TransactionConflictException') return true;
  const reasons = getCancellationReasons(err);
  return Boolean(
    reasons?.some((r) => r.Code === 'TransactionConflict') &&
    !reasons.some((r) => r.Code === 'ConditionalCheckFailed'),
  );
}

/** Retries DynamoDB transaction conflicts up to 3 times with short jittered backoff (architecture, section 3.3). */
export async function withConflictRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maxRetries = 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (!isTransactionConflict(err) || attempt >= maxRetries) throw err;
      const delayMs = Math.floor((15 + Math.random() * 20) * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** `duplicate`: a resent message already stored (RF12); `gone`: reply not delivered because the connection answered 410. */
export type LogResult = 'ok' | 'duplicate' | 'error' | 'rejected' | 'gone';

/** What a handler reports about its request; `statusCode` matters only to $connect, where it decides the handshake. */
export interface Outcome {
  result: LogResult;
  code?: ErrorCode;
  error?: string;
  statusCode?: number;
  username?: string;
  conversationId?: string;
}

/** First 12 hex characters of HMAC-SHA256(secret, value), keeping logs correlatable without raw ids (section 5). */
export function anonymize(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 12);
}

const HMAC_FETCH_TIMEOUT_MS = 1_000;
// After a failed fetch, requests log without ids until this delay passes, instead of each one calling SSM again.
export const HMAC_RETRY_DELAY_MS = 60_000;

let hmacSecretPromise: Promise<string | undefined> | undefined;
let hmacRetryAt: number | undefined;

/** Clears the cached SSM secret (for unit tests). */
export function resetHmacSecretCache() {
  hmacSecretPromise = undefined;
  hmacRetryAt = undefined;
}

function getHmacSecret(): Promise<string | undefined> {
  const paramName = process.env.LOG_HMAC_SECRET_PARAM;
  if (!paramName) return Promise.resolve(undefined);
  if (!hmacSecretPromise || (hmacRetryAt !== undefined && Date.now() >= hmacRetryAt)) {
    hmacRetryAt = undefined;
    hmacSecretPromise = ssm
      .send(new GetParameterCommand({ Name: paramName, WithDecryption: true }), {
        abortSignal: AbortSignal.timeout(HMAC_FETCH_TIMEOUT_MS),
      })
      .then((res) => {
        if (!res.Parameter?.Value) throw new Error(`Empty SSM parameter ${paramName}`);
        return res.Parameter.Value;
      })
      .catch((err) => {
        hmacRetryAt = Date.now() + HMAC_RETRY_DELAY_MS;
        console.warn(JSON.stringify({ event: 'hmacSecretUnavailable', error: errorName(err) }));
        return undefined;
      });
  }
  return hmacSecretPromise;
}

// Start fetching the SSM secret during Lambda cold start without blocking handler logic.
if (process.env.LOG_HMAC_SECRET_PARAM) {
  void getHmacSecret();
}

export function log(entry: {
  route: string;
  result: LogResult;
  code?: ErrorCode;
  error?: string;
  connectionId?: string;
  username?: string;
  conversationId?: string;
  durationMs: number;
}) {
  console.log(JSON.stringify(entry));
}

/** Formats an exception name, listing distinct inner names for an AggregateError. */
export function errorName(err: unknown): string {
  if (err instanceof AggregateError) {
    return [...new Set(err.errors.map(errorName))].join(', ') || err.name;
  }
  return err instanceof Error ? err.name : 'unknown';
}

/** Rethrows a single failure directly, or wraps multiple failures in an AggregateError. */
export function rethrowFailures(failures: unknown[]): never {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, `${failures.length} operations failed`);
}

function anonymizeIds(
  secret: string | undefined,
  ids: { connectionId?: string; username?: string; conversationId?: string },
) {
  if (!secret) return {};
  return {
    ...(ids.connectionId && { connectionId: anonymize(ids.connectionId, secret) }),
    ...(ids.username && { username: anonymize(ids.username, secret) }),
    ...(ids.conversationId && { conversationId: anonymize(ids.conversationId, secret) }),
  };
}

/**
 * Wraps a handler so that every request writes exactly one log line, including a request that throws (RNF03).
 * Durations count from requestTimeEpoch, when API Gateway received the request, so every route measures the same span.
 */
export function withRequestLog(
  handle: (event: APIGatewayProxyWebsocketEventV2) => Promise<Outcome>,
) {
  return async (event: APIGatewayProxyWebsocketEventV2) => {
    const { routeKey: route, requestTimeEpoch, connectionId } = event.requestContext;
    const secretPromise = getHmacSecret();
    try {
      const { statusCode = 200, username, conversationId, ...outcome } = await handle(event);
      const secret = await secretPromise;
      log({
        route,
        ...outcome,
        ...anonymizeIds(secret, { connectionId, username, conversationId }),
        durationMs: Date.now() - requestTimeEpoch,
      });
      return { statusCode };
    } catch (err) {
      const secret = await secretPromise;
      log({
        route,
        result: 'error',
        error: errorName(err),
        ...anonymizeIds(secret, { connectionId }),
        durationMs: Date.now() - requestTimeEpoch,
      });
      throw err;
    }
  };
}

/**
 * Announces a user's current presence and displayName to all contacts (members of visible or hidden
 * conversations) and advances `announcedVersion` conditionally (architecture, section 3.5; D10, D11).
 */
export async function announcePresence(user: PresenceUserRecord): Promise<void> {
  const membershipsTable = table('MEMBERSHIPS_TABLE');
  const conversationsTable = table('CONVERSATIONS_TABLE');
  const usersTable = table('USERS_TABLE');

  const conversationIds: string[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: membershipsTable,
        KeyConditionExpression: 'username = :username',
        ExpressionAttributeValues: { ':username': user.username },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of (res?.Items ?? []) as { conversationId?: string }[]) {
      if (typeof item.conversationId === 'string') conversationIds.push(item.conversationId);
    }
    ExclusiveStartKey = res?.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  if (conversationIds.length > 0) {
    const uniqueConvIds = [...new Set(conversationIds)];
    const convs = await batchGet<{ members?: Set<string> | string[] }>(
      conversationsTable,
      uniqueConvIds.map((conversationId) => ({ conversationId })),
    );
    const contacts = new Set<string>();
    for (const conv of convs) {
      for (const member of toStringSet(conv.members)) {
        if (member !== user.username) contacts.add(member);
      }
    }

    if (contacts.size > 0) {
      const contactRecords = await batchGet<PresenceUserRecord>(
        usersTable,
        [...contacts].map((username) => ({ username })),
      );
      const event = {
        type: 'presence',
        username: user.username,
        displayName: user.displayName,
        online: toStringSet(user.connections).size > 0,
        version: user.version,
      };
      const deliveries: Promise<boolean>[] = [];
      for (const contact of contactRecords) {
        for (const connId of toStringSet(contact.connections)) {
          // Do not recurse presence announcements on 410; presenceSweeper catches up any dropped contact.
          deliveries.push(send(connId, contact.username, event, false));
        }
      }
      await settle(deliveries);
    }
  }

  try {
    await db.send(
      new UpdateCommand({
        TableName: usersTable,
        Key: { username: user.username },
        UpdateExpression: 'SET announcedVersion = :v',
        ConditionExpression: 'attribute_not_exists(announcedVersion) OR announcedVersion < :v',
        ExpressionAttributeValues: { ':v': user.version },
      }),
    );
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
}

export interface UnbindResult {
  owner?: string;
  announced: boolean;
}

/** Unbinds a connection from its user (architecture, section 3.4). `username` is passed when a post to the connection answered 410. */
export async function unbind(
  connectionId: string,
  username?: string,
  announce = true,
): Promise<UnbindResult> {
  const { Item } = await db.send(
    new GetCommand({
      TableName: table('CONNECTIONS_TABLE'),
      Key: { connectionId },
      ConsistentRead: true,
    }),
  );
  if (!Item && !username) return { announced: false };
  if (Item && username && Date.now() - Item.connectedAt < HANDSHAKE_GRACE_MS) {
    return { owner: Item.username, announced: false };
  }
  const owner: string = Item?.username ?? username;

  let updatedUser: PresenceUserRecord | undefined;
  try {
    const res = await db.send(
      new UpdateCommand({
        TableName: table('USERS_TABLE'),
        Key: { username: owner },
        UpdateExpression: 'DELETE connections :c ADD version :one SET changedAt = :now',
        ConditionExpression: 'contains(connections, :id)',
        ExpressionAttributeValues: {
          ':c': new Set([connectionId]),
          ':id': connectionId,
          ':one': 1,
          ':now': Date.now(),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    if (res?.Attributes && typeof res.Attributes.version === 'number') {
      updatedUser = res.Attributes as PresenceUserRecord;
    }
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }

  await db.send(
    new DeleteCommand({ TableName: table('CONNECTIONS_TABLE'), Key: { connectionId } }),
  );
  if (announce && updatedUser) {
    await announcePresence(updatedUser);
    return { owner, announced: true };
  }
  return { owner, announced: false };
}

/** Refreshes lastSeenAt and resolves the connection's user; undefined when the connection has no record. */
export async function touch(connectionId: string, now: number): Promise<string | undefined> {
  try {
    const { Attributes } = await db.send(
      new UpdateCommand({
        TableName: table('CONNECTIONS_TABLE'),
        Key: { connectionId },
        UpdateExpression: 'SET lastSeenAt = :now',
        ConditionExpression: 'attribute_exists(connectionId)',
        ExpressionAttributeValues: { ':now': now },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes?.username;
  } catch (err) {
    if (isConditionFailure(err)) return undefined;
    throw err;
  }
}

/**
 * Waits for every task and returns all resolved values, or rethrows any failure(s)
 * (wrapping multiple rejections in an AggregateError), so one failed delivery neither stops
 * the others nor lets the Lambda return while they are still in flight.
 */
export async function settle<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  const failures: unknown[] = [];
  const values: T[] = [];
  for (const r of results) {
    if (r.status === 'rejected') {
      if (r.reason instanceof AggregateError) failures.push(...r.reason.errors);
      else failures.push(r.reason);
    } else {
      values.push(r.value);
    }
  }
  if (failures.length > 0) rethrowFailures(failures);
  return values;
}

const isGone = (err: unknown) => (err as Error).name === 'GoneException';

/**
 * Posts an event to a connection and tells whether it was delivered. On 410 Gone it unbinds the connection (RF08).
 * `username` is undefined when the connection has no record.
 */
export async function send(
  connectionId: string,
  username: string | undefined,
  event: object,
  announceOnGone = true,
): Promise<boolean> {
  try {
    await api.send(
      new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(event) }),
    );
    return true;
  } catch (err) {
    if (!isGone(err)) throw err;
    await unbind(connectionId, username, announceOnGone);
    return false;
  }
}

/** Sends a response event to a single client request (D06). */
export function sendResponse(
  connectionId: string,
  username: string,
  requestId: string,
  data: object,
) {
  return send(connectionId, username, { type: 'response', requestId, data });
}

/** Sends an error event (RF09). `requestId` and `messageId` go only when present as non-empty strings. */
export function sendError(
  connectionId: string,
  username: string | undefined,
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    messageId?: string;
    details?: ErrorDetails;
  },
) {
  const { code, message, requestId, messageId, details } = error;
  return send(connectionId, username, {
    type: 'error',
    ...(requestId && { requestId }),
    ...(messageId && { messageId }),
    code,
    message,
    ...(details && { details }),
  });
}

/** Closes a connection. One that is already gone needs nothing; any other failure is real and propagates. */
export async function close(connectionId: string) {
  try {
    await api.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
  } catch (err) {
    if (!isGone(err)) throw err;
  }
}

/** Parses a request body, returning undefined when it is not a JSON object. */
export function parseBody(body: string | undefined): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(body ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const USERNAME = /^[a-z0-9._-]{3,32}$/;

export function parseUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return USERNAME.test(normalized) ? normalized : undefined;
}

export function isValidNameLength(name: string): boolean {
  const length = [...name].length;
  return length >= 1 && length <= 50;
}

// Controls, line and paragraph separators and format characters (bidi controls, zero-width spaces),
// except the joiners that most emoji sequences and some scripts need (tag-based subdivision flags stay rejected).
const DISALLOWED_NAME_CHAR = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u;
// A character that is neither blank nor ignorable, unlike the Hangul filler.
const VISIBLE_NAME_CHAR = /[^\s\p{Default_Ignorable_Code_Point}]/u;

/**
 * Validates and normalizes a display or group name (architecture, sections 3.1 and 4.5):
 * rejects the characters above, trims outer whitespace, and requires 1 to 50 Unicode code
 * points with at least one visible character.
 */
export function parseDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (DISALLOWED_NAME_CHAR.test(value)) return undefined;
  const trimmed = value.trim();
  return isValidNameLength(trimmed) && VISIBLE_NAME_CHAR.test(trimmed) ? trimmed : undefined;
}
