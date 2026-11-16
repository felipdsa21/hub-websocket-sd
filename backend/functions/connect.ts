import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { db, isValidNameLength, parseUsername, withRequestLog } from './shared';

// Only a cleanup for records the presence sweeper missed (D05).
const RECORD_TTL_S = 3 * 60 * 60;

/** Validates the query string (RF01); undefined means the handshake must fail. */
export function parseIdentity(query: Record<string, string | undefined> | undefined) {
  const username = parseUsername(query?.username);
  if (!username) return undefined;
  const displayName = query?.displayName ?? username;
  if (!isValidNameLength(displayName) || displayName !== displayName.trim()) return undefined;
  return { username, displayName };
}

export const handler = withRequestLog(async (event) => {
  const { connectionId, requestTimeEpoch: now } = event.requestContext;
  const identity = parseIdentity(event.queryStringParameters);
  if (!identity) return { statusCode: 400, result: 'rejected', code: 'invalidRequest' };

  // The record is written before the id joins Users.connections, so every id in the set has a record (D09).
  await db.send(
    new PutCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      Item: {
        connectionId,
        username: identity.username,
        connectedAt: now,
        lastSeenAt: now,
        expiresAt: Math.floor(now / 1000) + RECORD_TTL_S,
      },
    }),
  );
  await db.send(
    new UpdateCommand({
      TableName: process.env.USERS_TABLE,
      Key: { username: identity.username },
      UpdateExpression:
        'ADD connections :c, version :one SET displayName = :name, changedAt = :now, announcedVersion = if_not_exists(announcedVersion, :zero)',
      ExpressionAttributeValues: {
        ':c': new Set([connectionId]),
        ':one': 1,
        ':name': identity.displayName,
        ':now': now,
        ':zero': 0,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  // shortcut: presence is not announced to contacts yet (section 3.5); the sweeper or week 5 catches up.

  return { result: 'ok' };
});
