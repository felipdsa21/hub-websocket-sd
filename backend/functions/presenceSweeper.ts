import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { scanAllUsers, toStringSet } from './data';
import { close, db, errorName, log, rethrowFailures, settle, unbind } from './shared';

export const cloudwatch = new CloudWatchClient({});

// A connection with no request for this long is expired (RF07, architecture section 3.4).
export const IDLE_MS = 10 * 60 * 1000;
// The schedule has 1-minute resolution and may run late, so each run scans Connections twice.
export const SECOND_SCAN_DELAY_MS = 30_000;
export const OPEN_CONNECTIONS_METRIC = 'OpenConnections';

/** Scans Connections, closing and unbinding the idle ones; returns the seen ids and remaining active count. */
async function sweepConnections(
  seen = new Set<string>(),
): Promise<{ seen: Set<string>; active: number }> {
  const expired: string[] = [];
  let active = 0;
  const cutoff = Date.now() - IDLE_MS;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await db.send(
      new ScanCommand({
        TableName: process.env.CONNECTIONS_TABLE,
        ProjectionExpression: 'connectionId, lastSeenAt',
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of Items ?? []) {
      seen.add(item.connectionId);
      if (item.lastSeenAt < cutoff) expired.push(item.connectionId);
      else active++;
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
  return { seen, active };
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

/** Publishes the open-connections count to CloudWatch (architecture, section 5; RNF06). */
async function publishOpenConnections(count: number) {
  const namespace = process.env.METRICS_NAMESPACE;
  if (!namespace) return;
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [{ MetricName: OPEN_CONNECTIONS_METRIC, Value: count, Unit: 'Count' }],
    }),
  );
}

/** Runs every minute from EventBridge Scheduler (D05); the TTL on Connections is only a cleanup. */
export async function handler() {
  const start = Date.now();
  const errors: unknown[] = [];
  const run = async <T>(step: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await step();
    } catch (err) {
      if (err instanceof AggregateError) errors.push(...err.errors);
      else errors.push(err);
      return undefined;
    }
  };

  try {
    const seen = new Set<string>();
    const first = await run(() => sweepConnections(seen));
    await run(() => sweepOrphans(seen));
    const delay = start + SECOND_SCAN_DELAY_MS - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const second = await run(() => sweepConnections());
    const active = second?.active ?? first?.active;
    if (active !== undefined) {
      await run(() => publishOpenConnections(active));
    }
    if (errors.length > 0) rethrowFailures(errors);
    // shortcut: presence re-announcement (section 3.5) is added with the presence events PR.
    log({ route: 'presenceSweeper', result: 'ok', durationMs: Date.now() - start });
  } catch (err) {
    log({
      route: 'presenceSweeper',
      result: 'error',
      error: errorName(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }
}
