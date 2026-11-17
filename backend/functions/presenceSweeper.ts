import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { scanAllUsers, toStringSet } from './data';
import { close, db, log, settle, unbind } from './shared';

// A connection with no request for this long is expired (RF07, architecture section 3.4).
export const IDLE_MS = 10 * 60 * 1000;
// The schedule has 1-minute resolution and may run late, so each run scans Connections twice.
export const SECOND_SCAN_DELAY_MS = 30_000;

/** Scans Connections, closing and unbinding the idle ones; returns every id it saw. */
async function sweepConnections(): Promise<Set<string>> {
  const seen = new Set<string>();
  const expired: string[] = [];
  const cutoff = Date.now() - IDLE_MS;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await db.send(
      new ScanCommand({
        TableName: process.env.CONNECTIONS_TABLE,
        ProjectionExpression: 'connectionId, lastSeenAt',
        ExclusiveStartKey,
      }),
    );
    for (const item of Items ?? []) {
      seen.add(item.connectionId);
      if (item.lastSeenAt < cutoff) expired.push(item.connectionId);
    }
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);

  // The connection may already be down, so a failed close is ignored; one failed unbind must not stop the others.
  await settle(
    expired.map(async (id) => {
      await close(id).catch(() => undefined);
      await unbind(id);
    }),
  );
  return seen;
}

/**
 * Unbinds ids left in Users.connections without a Connections record, e.g. after the TTL deleted it.
 * Each is re-read before unbinding because a Scan is not a snapshot of a single instant (architecture, section 3.4).
 */
async function sweepOrphans(seen: Set<string>) {
  const users = await scanAllUsers();
  const orphans: Promise<void>[] = [];
  for (const user of users.values()) {
    for (const id of toStringSet(user.connections)) {
      if (seen.has(id)) continue;
      orphans.push(
        (async () => {
          const { Item } = await db.send(
            new GetCommand({
              TableName: process.env.CONNECTIONS_TABLE,
              Key: { connectionId: id },
              ConsistentRead: true,
            }),
          );
          if (!Item) await unbind(id, user.username);
        })(),
      );
    }
  }
  await settle(orphans);
}

/** Runs every minute from EventBridge Scheduler (D05); the TTL on Connections is only a cleanup. */
export async function handler() {
  const start = Date.now();
  try {
    const seen = await sweepConnections();
    await sweepOrphans(seen);
    await new Promise((resolve) => setTimeout(resolve, SECOND_SCAN_DELAY_MS));
    await sweepConnections();
    // shortcut: no re-announcement of presence (section 3.5) nor open-connections metric (section 5) yet; add with the presence events.
    log({ route: 'presenceSweeper', result: 'ok', durationMs: Date.now() - start });
  } catch (err) {
    log({
      route: 'presenceSweeper',
      result: 'error',
      error: err instanceof Error ? err.name : 'unknown',
      durationMs: Date.now() - start,
    });
    throw err;
  }
}
