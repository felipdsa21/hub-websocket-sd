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
import { IDLE_MS, handler } from '../functions/presenceSweeper';
import { errorName, settle } from '../functions/shared';

const db = mockClient(DynamoDBDocumentClient);
const api = mockClient(ApiGatewayManagementApiClient);
const gone = new GoneException({ message: 'gone', $metadata: {} });
const limitExceeded = new LimitExceededException({ message: 'limit', $metadata: {} });
const internalError = new Error('internal');
const NOW = 1_731_542_400_123;

const unboundIds = () =>
  db.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key?.connectionId);

beforeAll(() => {
  process.env.CONNECTIONS_TABLE = 'Connections';
  process.env.USERS_TABLE = 'Users';
});

let logSpy: jest.SpyInstance;
const logged = () => logSpy.mock.calls.map((c) => JSON.parse(String(c[0])));

beforeEach(() => {
  db.reset();
  api.reset();
  jest.useFakeTimers({ now: NOW });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  db.on(ScanCommand, { TableName: 'Users' }).resolves({ Items: [] });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('presenceSweeper', () => {
  test('closes and unbinds only the connections idle for over 10 minutes in a single scan (RF07, M7)', async () => {
    db.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [
        { connectionId: 'old', lastSeenAt: NOW - IDLE_MS - 1 },
        { connectionId: 'fresh', lastSeenAt: NOW - 1000 },
      ],
    });
    db.on(GetCommand).resolves({ Item: { connectionId: 'old', username: 'ana', connectedAt: 0 } });

    await handler();

    const closed = api
      .commandCalls(DeleteConnectionCommand)
      .map((c) => c.args[0].input.ConnectionId);
    expect(new Set(closed)).toEqual(new Set(['old']));
    expect(new Set(unboundIds())).toEqual(new Set(['old']));
    expect(db.commandCalls(UpdateCommand)[0]!.args[0].input.Key).toEqual({ username: 'ana' });
    const scans = db.commandCalls(ScanCommand, { TableName: 'Connections' });
    expect(scans).toHaveLength(1);
    expect(scans[0]!.args[0].input.ConsistentRead).toBe(true);
  });

  test('still unbinds an idle connection whose close fails', async () => {
    db.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [{ connectionId: 'old', lastSeenAt: 0 }],
    });
    db.on(GetCommand).resolves({ Item: { connectionId: 'old', username: 'ana', connectedAt: 0 } });
    api.on(DeleteConnectionCommand).rejects(limitExceeded);

    await handler();

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

    await handler();

    expect(unboundIds()).toEqual(['ghost']);
    expect(
      db.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues,
    ).toMatchObject({
      ':id': 'ghost',
    });
  });

  test('one failed unbind does not stop the others or orphan cleanup', async () => {
    db.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [
        { connectionId: 'a', lastSeenAt: 0 },
        { connectionId: 'b', lastSeenAt: 0 },
      ],
    });
    db.on(ScanCommand, { TableName: 'Users' }).resolves({
      Items: [{ username: 'bia', connections: new Set(['b', 'ghost']), version: 1 }],
    });
    db.on(GetCommand, { Key: { connectionId: 'a' } }).rejects(limitExceeded);
    db.on(GetCommand, { Key: { connectionId: 'b' } }).resolves({
      Item: { connectionId: 'b', username: 'bia', connectedAt: 0 },
    });
    db.on(GetCommand, { Key: { connectionId: 'ghost' } }).resolves({});

    await expect(handler()).rejects.toThrow(limitExceeded);

    expect(unboundIds()).toEqual(['b', 'ghost']);
  });

  test('runs every step and logs all error names when multiple steps fail', async () => {
    db.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [{ connectionId: 'a', lastSeenAt: 0 }],
    });
    db.on(GetCommand, { Key: { connectionId: 'a' } }).rejects(limitExceeded);
    db.on(ScanCommand, { TableName: 'Users' }).rejects(internalError);

    const err = await handler().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([limitExceeded, internalError]);
    expect(logged()).toEqual([
      expect.objectContaining({
        route: 'presenceSweeper',
        result: 'error',
        error: 'LimitExceededException, Error',
      }),
    ]);
  });
});

describe('fanOut and settle', () => {
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
    await expect(fanOut(['ana', 'bia'], { type: 'x' }, users, 'c2')).resolves.toBe(false);

    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(6);
    expect(unboundIds()).toEqual(['c2', 'c2']);
  });

  test('any other failure is rethrown only after every delivery was attempted', async () => {
    api.on(PostToConnectionCommand, { ConnectionId: 'c1' }).rejects(limitExceeded);

    await expect(fanOut(['ana', 'bia'], { type: 'x' }, users)).rejects.toThrow(limitExceeded);

    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(3);
  });

  test('preserves every failure in an AggregateError when multiple deliveries fail', async () => {
    api.on(PostToConnectionCommand, { ConnectionId: 'c1' }).rejects(limitExceeded);
    api.on(PostToConnectionCommand, { ConnectionId: 'c2' }).rejects(internalError);

    const err = await fanOut(['ana', 'bia'], { type: 'x' }, users).catch((e: unknown) => e);

    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(3);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([limitExceeded, internalError]);
    expect(errorName(err)).toBe('LimitExceededException, Error');
  });

  test('settle returns every resolved value when all tasks succeed', async () => {
    await expect(settle([Promise.resolve(1), Promise.resolve(2)])).resolves.toEqual([1, 2]);
  });
});
