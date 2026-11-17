import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GoneException,
  LimitExceededException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { fanOut } from '../functions/data';
import { IDLE_MS, SECOND_SCAN_DELAY_MS, handler } from '../functions/presenceSweeper';

const db = mockClient(DynamoDBDocumentClient);
const api = mockClient(ApiGatewayManagementApiClient);
const gone = new GoneException({ message: 'gone', $metadata: {} });
const limitExceeded = new LimitExceededException({ message: 'limit', $metadata: {} });
const NOW = 1_731_542_400_123;

const unboundIds = () =>
  db.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key?.connectionId);

/** Runs the sweeper, letting the fake clock skip the wait before the second scan. */
async function runSweeper() {
  const run = handler();
  await jest.advanceTimersByTimeAsync(SECOND_SCAN_DELAY_MS);
  return run;
}

beforeAll(() => {
  process.env.CONNECTIONS_TABLE = 'Connections';
  process.env.USERS_TABLE = 'Users';
});

beforeEach(() => {
  db.reset();
  api.reset();
  jest.useFakeTimers({ now: NOW });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  db.on(ScanCommand, { TableName: 'Users' }).resolves({ Items: [] });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('presenceSweeper', () => {
  test('closes and unbinds only the connections idle for over 10 minutes (RF07)', async () => {
    db.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [
        { connectionId: 'old', lastSeenAt: NOW - IDLE_MS - 1 },
        { connectionId: 'fresh', lastSeenAt: NOW - 1000 },
      ],
    });
    db.on(GetCommand).resolves({ Item: { connectionId: 'old', username: 'ana', connectedAt: 0 } });

    await runSweeper();

    const closed = api
      .commandCalls(DeleteConnectionCommand)
      .map((c) => c.args[0].input.ConnectionId);
    expect(new Set(closed)).toEqual(new Set(['old']));
    expect(new Set(unboundIds())).toEqual(new Set(['old']));
    expect(db.commandCalls(UpdateCommand)[0]!.args[0].input.Key).toEqual({ username: 'ana' });
    expect(db.commandCalls(ScanCommand, { TableName: 'Connections' })).toHaveLength(2);
  });

  test('still unbinds an idle connection whose close fails', async () => {
    db.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [{ connectionId: 'old', lastSeenAt: 0 }],
    });
    db.on(GetCommand).resolves({ Item: { connectionId: 'old', username: 'ana', connectedAt: 0 } });
    api.on(DeleteConnectionCommand).rejects(limitExceeded);

    await runSweeper();

    expect(unboundIds()).toContain('old');
  });

  test('unbinds ids left in Users.connections without a record, after re-reading them', async () => {
    db.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [{ connectionId: 'live', lastSeenAt: NOW }],
    });
    db.on(ScanCommand, { TableName: 'Users' }).resolves({
      Items: [{ username: 'ana', connections: new Set(['live', 'ghost', 'opening']), version: 1 }],
    });
    db.on(GetCommand, { Key: { connectionId: 'ghost' } }).resolves({});
    db.on(GetCommand, { Key: { connectionId: 'opening' } }).resolves({
      Item: { connectionId: 'opening', username: 'ana', connectedAt: NOW },
    });

    await runSweeper();

    expect(unboundIds()).toEqual(['ghost']);
    expect(
      db.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues,
    ).toMatchObject({
      ':id': 'ghost',
    });
  });

  test('one failed unbind does not stop the others, and the run reports the failure', async () => {
    db.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [
        { connectionId: 'a', lastSeenAt: 0 },
        { connectionId: 'b', lastSeenAt: 0 },
      ],
    });
    db.on(GetCommand, { Key: { connectionId: 'a' } }).rejects(limitExceeded);
    db.on(GetCommand, { Key: { connectionId: 'b' } }).resolves({
      Item: { connectionId: 'b', username: 'bia', connectedAt: 0 },
    });

    const run = handler();
    const outcome = expect(run).rejects.toThrow(limitExceeded);
    await jest.advanceTimersByTimeAsync(SECOND_SCAN_DELAY_MS);
    await outcome;

    expect(unboundIds()).toEqual(['b']);
  });
});

describe('fanOut', () => {
  const users = new Map([
    [
      'ana',
      { username: 'ana', displayName: 'Ana', connections: new Set(['c1', 'c2']), version: 1 },
    ],
    ['bia', { username: 'bia', displayName: 'Bia', connections: new Set(['c3']), version: 1 }],
  ]);

  test('a 410 unbinds that connection only and the rest still receive the event (RF08)', async () => {
    db.on(GetCommand).resolves({ Item: { connectionId: 'c2', username: 'ana', connectedAt: 0 } });
    api.on(PostToConnectionCommand, { ConnectionId: 'c2' }).rejects(gone);

    await expect(fanOut(['ana', 'bia'], { type: 'x' }, users, 'c1')).resolves.toBe(true);

    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(3);
    expect(unboundIds()).toEqual(['c2']);
  });

  test('any other failure is rethrown only after every delivery was attempted', async () => {
    api.on(PostToConnectionCommand, { ConnectionId: 'c1' }).rejects(limitExceeded);

    await expect(fanOut(['ana', 'bia'], { type: 'x' }, users)).rejects.toThrow(limitExceeded);

    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(3);
  });
});
