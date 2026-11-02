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

// shortcut: logs carry no identifiers until the SSM secret for the HMAC exists (architecture, section 5), week 6.
export function log(entry: {
  route: string;
  result: string;
  code?: ErrorCode;
  durationMs: number;
}) {
  console.log(JSON.stringify(entry));
}

/** Unbinds a connection from its user (architecture, section 3.4). `username` is passed only by the fan-out. */
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

/** Posts an event to a connection, unbinding it on 410 Gone (RF08). */
export async function send(connectionId: string, username: string, event: object) {
  try {
    await api.send(
      new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(event) }),
    );
  } catch (err) {
    if ((err as Error).name !== 'GoneException') throw err;
    await unbind(connectionId, username);
  }
}

/** Closes a connection, ignoring errors because it may already be gone. */
export async function close(connectionId: string) {
  try {
    await api.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
  } catch {}
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
