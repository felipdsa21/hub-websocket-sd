import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { scanAllUsers, toStringSet } from './data';
import {
  REANNOUNCE_DELAY_MS,
  announcePresence,
  close,
  db,
  errorName,
  log,
  rethrowFailures,
  settle,
  unbind,
} from './shared';

export const cloudwatch = new CloudWatchClient({});

// A connection with no request for this long is expired (RF07, architecture section 3.4).
export const IDLE_MS = 10 * 60 * 1000;
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
 * Scans Users once to unbind orphan connection ids (architecture, section 3.4) and re-announce
 * stale presence updates where `announcedVersion < version` for over 1 minute (section 3.5).
 */
async function sweepUsers(seen: Set<string>) {
  const users = await scanAllUsers();
  const cutoff = Date.now() - REANNOUNCE_DELAY_MS;
  const tasks: Promise<void>[] = [];

  for (const user of users.values()) {
    const candidates = [...toStringSet(user.connections)].filter((id) => !seen.has(id));
    const needsReannounce =
      user.version > (user.announcedVersion ?? 0) &&
      typeof user.changedAt === 'number' &&
      user.changedAt < cutoff;

    if (candidates.length === 0 && !needsReannounce) continue;

    tasks.push(
      (async () => {
        let unboundAny = false;
        if (candidates.length > 0) {
          await settle(
            candidates.map(async (id) => {
              const { Item } = await db.send(
                new GetCommand({
                  TableName: process.env.CONNECTIONS_TABLE,
                  Key: { connectionId: id },
                  ConsistentRead: true,
                }),
              );
              if (!Item) {
                const { announced } = await unbind(id, user.username);
                if (announced) unboundAny = true;
              }
            }),
          );
        }
        // If an orphan was unbound, unbind() already updated and announced the fresher version.
        if (needsReannounce && !unboundAny) {
          await announcePresence(user);
        }
      })(),
    );
  }
  await settle(tasks);
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
    const swept = await run(() => sweepConnections(seen));
    await run(() => sweepUsers(seen));
    if (swept !== undefined) {
      await run(() => publishOpenConnections(swept.active));
    }
    if (errors.length > 0) rethrowFailures(errors);
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
