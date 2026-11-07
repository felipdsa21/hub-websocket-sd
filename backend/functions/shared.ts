import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const api = new ApiGatewayManagementApiClient({ endpoint: process.env.CALLBACK_URL });

// A connection id enters Users.connections before the handshake ends, and a postToConnection in that window also answers 410.
const HANDSHAKE_GRACE_MS = 30_000;

export type ErrorCode =
  | 'invalidRequest'
  | 'unknownAction'
  | 'forbidden'
  | 'notFound'
  | 'invalidOperation'
  | 'conflict'
  | 'notRegistered'
  | 'lastMember';

export const isConditionFailure = (err: unknown) =>
  (err as Error).name === 'ConditionalCheckFailedException';

/** `gone`: the reply was not delivered because the connection answered 410. */
export type LogResult = 'ok' | 'error' | 'rejected' | 'gone';

/** What a handler reports about its request; `statusCode` matters only to $connect, where it decides the handshake. */
export interface Outcome {
  result: LogResult;
  code?: ErrorCode;
  statusCode?: number;
}

// shortcut: logs carry no identifiers until the SSM secret for the HMAC exists (architecture, section 5), week 6.
export function log(entry: {
  route: string;
  result: LogResult;
  code?: ErrorCode;
  error?: string;
  durationMs: number;
}) {
  console.log(JSON.stringify(entry));
}

/**
 * Wraps a handler so that every request writes exactly one log line, including a request that throws (RNF03).
 * Durations count from requestTimeEpoch, when API Gateway received the request, so every route measures the same span.
 */
export function withRequestLog(
  handle: (event: APIGatewayProxyWebsocketEventV2) => Promise<Outcome>,
) {
  return async (event: APIGatewayProxyWebsocketEventV2) => {
    const { routeKey: route, requestTimeEpoch } = event.requestContext;
    try {
      const { statusCode = 200, ...outcome } = await handle(event);
      log({ route, ...outcome, durationMs: Date.now() - requestTimeEpoch });
      return { statusCode };
    } catch (err) {
      log({
        route,
        result: 'error',
        error: err instanceof Error ? err.name : 'unknown',
        durationMs: Date.now() - requestTimeEpoch,
      });
      throw err;
    }
  };
}

/** Unbinds a connection from its user (architecture, section 3.4). `username` is passed when a post to the connection answered 410. */
export async function unbind(connectionId: string, username?: string) {
  const { Item } = await db.send(
    new GetCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      Key: { connectionId },
      ConsistentRead: true,
    }),
  );
  if (!Item && !username) return;
  if (Item && username && Date.now() - Item.connectedAt < HANDSHAKE_GRACE_MS) return;
  const owner: string = Item?.username ?? username;

  try {
    await db.send(
      new UpdateCommand({
        TableName: process.env.USERS_TABLE,
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
    // shortcut: presence is not announced to contacts yet (section 3.5); announcedVersion stays behind, week 5.
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }

  await db.send(
    new DeleteCommand({ TableName: process.env.CONNECTIONS_TABLE, Key: { connectionId } }),
  );
}

/** Refreshes lastSeenAt and resolves the connection's user; undefined when the connection has no record. */
export async function touch(connectionId: string, now: number): Promise<string | undefined> {
  try {
    const { Attributes } = await db.send(
      new UpdateCommand({
        TableName: process.env.CONNECTIONS_TABLE,
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

const isGone = (err: unknown) => (err as Error).name === 'GoneException';

/**
 * Posts an event to a connection and tells whether it was delivered. On 410 Gone it unbinds the connection (RF08).
 * `username` is undefined when the connection has no record.
 */
export async function send(
  connectionId: string,
  username: string | undefined,
  event: object,
): Promise<boolean> {
  try {
    await api.send(
      new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(event) }),
    );
    return true;
  } catch (err) {
    if (!isGone(err)) throw err;
    await unbind(connectionId, username);
    return false;
  }
}

/** Sends an error event (RF09). `requestId` goes only when the request carried a non-empty one. */
export function sendError(
  connectionId: string,
  username: string | undefined,
  error: { code: ErrorCode; message: string; requestId?: string },
) {
  const { code, message, requestId } = error;
  return send(connectionId, username, {
    type: 'error',
    ...(requestId && { requestId }),
    code,
    message,
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
