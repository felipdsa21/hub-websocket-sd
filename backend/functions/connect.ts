import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  PresenceUserRecord,
  announcePresence,
  db,
  errorName,
  parseDisplayName,
  parseUsername,
  withRequestLog,
} from './shared';

// Only a cleanup for records the presence sweeper missed (D05).
const RECORD_TTL_S = 3 * 60 * 60;

/** Validates the query string (RF01); undefined means the handshake must fail. */
export function parseIdentity(query: Record<string, string | undefined> | undefined) {
  const username = parseUsername(query?.username);
  if (!username) return undefined;
  const displayName =
    query?.displayName === undefined ? username : parseDisplayName(query.displayName);
  if (!displayName) return undefined;
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
  const res = await db.send(
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
  // Announcement failure is logged without failing the handshake; presenceSweeper catches up (section 3.4).
  let announceError: string | undefined;
  if (res?.Attributes && typeof res.Attributes.version === 'number') {
    try {
      await announcePresence(res.Attributes as PresenceUserRecord);
    } catch (err) {
      announceError = errorName(err);
    }
  }

  return {
    result: 'ok',
    username: identity.username,
    ...(announceError && { error: announceError }),
  };
});
