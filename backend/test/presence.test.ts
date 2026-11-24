import {
  ApiGatewayManagementApiClient,
  GoneException,
  LimitExceededException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { handler as connect } from '../functions/connect';
import { handler as disconnect } from '../functions/disconnect';
import { handler as presenceSweeper } from '../functions/presenceSweeper';
import { REANNOUNCE_DELAY_MS, announcePresence } from '../functions/shared';

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);

function wsEvent(
  routeKey: string,
  connectionId: string,
  query?: Record<string, string>,
): APIGatewayProxyWebsocketEventV2 {
  return {
    requestContext: { routeKey, connectionId, requestTimeEpoch: Date.now() },
    ...(query && { queryStringParameters: query }),
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

function postedEvents() {
  return apiMock.commandCalls(PostToConnectionCommand).map((c) => ({
    connectionId: c.args[0].input.ConnectionId,
    event: JSON.parse(String(c.args[0].input.Data)),
  }));
}

beforeEach(() => {
  ddbMock.reset();
  apiMock.reset();
  process.env.CONNECTIONS_TABLE = 'Connections';
  process.env.USERS_TABLE = 'Users';
  process.env.CONVERSATIONS_TABLE = 'Conversations';
  process.env.MEMBERSHIPS_TABLE = 'Memberships';
  process.env.MESSAGES_TABLE = 'Messages';
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  apiMock.on(PostToConnectionCommand).resolves({});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Presence announcements (RF01, RF07, section 3.5)', () => {
  test('$connect announces online state and displayName to visible and hidden contacts (D11)', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        username: 'alice',
        displayName: 'Alice Nova',
        connections: new Set(['c-alice-1']),
        version: 4,
      },
    });
    ddbMock.on(QueryCommand, { TableName: 'Memberships' }).resolves({
      Items: [
        { username: 'alice', conversationId: 'd:alice:bruno', hidden: false },
        { username: 'alice', conversationId: 'd:alice:carla', hidden: true },
      ],
    });
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: {
          Conversations: [
            { conversationId: 'd:alice:bruno', members: new Set(['alice', 'bruno']) },
            { conversationId: 'd:alice:carla', members: new Set(['alice', 'carla']) },
          ],
        },
      })
      .resolvesOnce({
        Responses: {
          Users: [
            {
              username: 'bruno',
              displayName: 'Bruno',
              connections: new Set(['c-bruno-1']),
              version: 2,
            },
            {
              username: 'carla',
              displayName: 'Carla',
              connections: new Set(['c-carla-1']),
              version: 3,
            },
          ],
        },
      });

    await connect(
      wsEvent('$connect', 'c-alice-1', { username: 'alice', displayName: 'Alice Nova' }),
    );

    const sent = postedEvents();
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.connectionId))).toEqual(new Set(['c-bruno-1', 'c-carla-1']));
    const usersBatchKeys =
      ddbMock.commandCalls(BatchGetCommand)[1]!.args[0].input.RequestItems?.Users?.Keys;
    expect(usersBatchKeys).toEqual([{ username: 'bruno' }, { username: 'carla' }]);
    for (const item of sent) {
      expect(item.event).toEqual({
        type: 'presence',
        username: 'alice',
        displayName: 'Alice Nova',
        online: true,
        version: 4,
      });
    }
    const announcedUpdate = ddbMock.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(announcedUpdate.UpdateExpression).toBe('SET announcedVersion = :v');
    expect(announcedUpdate.ExpressionAttributeValues).toEqual({ ':v': 4 });
  });

  test('$disconnect announces offline when the last connection closes', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { connectionId: 'c-alice-1', username: 'alice', connectedAt: 0 },
    });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        username: 'alice',
        displayName: 'Alice',
        connections: new Set(),
        version: 5,
      },
    });
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand, { TableName: 'Memberships' }).resolves({
      Items: [{ username: 'alice', conversationId: 'd:alice:bruno' }],
    });
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: {
          Conversations: [
            { conversationId: 'd:alice:bruno', members: new Set(['alice', 'bruno']) },
          ],
        },
      })
      .resolvesOnce({
        Responses: {
          Users: [
            {
              username: 'bruno',
              displayName: 'Bruno',
              connections: new Set(['c-bruno-1']),
              version: 2,
            },
          ],
        },
      });

    await disconnect(wsEvent('$disconnect', 'c-alice-1'));

    expect(postedEvents()).toEqual([
      {
        connectionId: 'c-bruno-1',
        event: {
          type: 'presence',
          username: 'alice',
          displayName: 'Alice',
          online: false,
          version: 5,
        },
      },
    ]);
  });

  test('does not advance announcedVersion when a delivery fails, and unbinds 410 contacts without recursing', async () => {
    ddbMock.on(QueryCommand, { TableName: 'Memberships' }).resolves({
      Items: [{ username: 'alice', conversationId: 'd:alice:bruno' }],
    });
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: {
          Conversations: [
            { conversationId: 'd:alice:bruno', members: new Set(['alice', 'bruno']) },
          ],
        },
      })
      .resolvesOnce({
        Responses: {
          Users: [
            {
              username: 'bruno',
              displayName: 'Bruno',
              connections: new Set(['c-gone', 'c-fail']),
              version: 2,
            },
          ],
        },
      });
    ddbMock.on(GetCommand, { Key: { connectionId: 'c-gone' } }).resolves({
      Item: { connectionId: 'c-gone', username: 'bruno', connectedAt: 0 },
    });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        username: 'bruno',
        displayName: 'Bruno',
        connections: new Set(['c-fail']),
        version: 3,
      },
    });
    ddbMock.on(DeleteCommand).resolves({});

    apiMock
      .on(PostToConnectionCommand, { ConnectionId: 'c-gone' })
      .rejects(new GoneException({ message: 'gone', $metadata: {} }));
    apiMock
      .on(PostToConnectionCommand, { ConnectionId: 'c-fail' })
      .rejects(new LimitExceededException({ message: 'limit', $metadata: {} }));

    await expect(
      announcePresence({
        username: 'alice',
        displayName: 'Alice',
        connections: new Set(['c-alice']),
        version: 7,
      }),
    ).rejects.toThrow('limit');

    // Only bruno's unbind happened; no recursive query for bruno's contacts and no announcedVersion update for alice.
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    const announcedUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.UpdateExpression === 'SET announcedVersion = :v');
    expect(announcedUpdates).toHaveLength(0);
  });

  test('presenceSweeper re-announces users with announcedVersion < version older than 1 minute', async () => {
    const now = 1_750_000_000_000;
    jest.useFakeTimers({ now });
    ddbMock.on(ScanCommand, { TableName: 'Connections' }).resolves({ Items: [] });
    ddbMock.on(ScanCommand, { TableName: 'Users' }).resolves({
      Items: [
        {
          username: 'stale',
          displayName: 'Stale',
          connections: new Set(),
          version: 3,
          announcedVersion: 2,
          changedAt: now - REANNOUNCE_DELAY_MS - 1_000,
        },
        {
          username: 'recent',
          displayName: 'Recent',
          connections: new Set(),
          version: 2,
          announcedVersion: 1,
          changedAt: now - 10_000,
        },
        {
          username: 'synced',
          displayName: 'Synced',
          connections: new Set(),
          version: 5,
          announcedVersion: 5,
          changedAt: now - REANNOUNCE_DELAY_MS - 5_000,
        },
      ],
    });
    ddbMock.on(QueryCommand, { TableName: 'Memberships' }).resolves({ Items: [] });
    ddbMock.on(UpdateCommand).resolves({});

    await presenceSweeper();

    const announcedKeys = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.UpdateExpression === 'SET announcedVersion = :v')
      .map((c) => c.args[0].input.Key?.username);
    expect(announcedKeys).toEqual(['stale']);
  });

  test('$connect logs announcement failure without failing the handshake (section 3.4)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        username: 'alice',
        displayName: 'Alice',
        connections: new Set(['c-alice-1']),
        version: 1,
      },
    });
    ddbMock
      .on(QueryCommand, { TableName: 'Memberships' })
      .rejects(new LimitExceededException({ message: 'limit', $metadata: {} }));

    const res = await connect(wsEvent('$connect', 'c-alice-1', { username: 'alice' }));

    expect(res).toEqual({ statusCode: 200 });
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toMatchObject({
      route: '$connect',
      result: 'ok',
      error: 'LimitExceededException',
    });
  });

  test('announcePresence ignores ConditionalCheckFailedException when a newer version is already announced (D10)', async () => {
    ddbMock.on(QueryCommand, { TableName: 'Memberships' }).resolves({ Items: [] });
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'stale version', $metadata: {} }));

    await expect(
      announcePresence({
        username: 'alice',
        displayName: 'Alice',
        connections: new Set(['c-alice-1']),
        version: 3,
      }),
    ).resolves.toBeUndefined();
  });

  test('presenceSweeper does not duplicate announcement when unbinding an orphan on a stale user', async () => {
    const now = 1_750_000_000_000;
    jest.useFakeTimers({ now });
    ddbMock.on(ScanCommand, { TableName: 'Connections' }).resolves({ Items: [] });
    ddbMock.on(ScanCommand, { TableName: 'Users' }).resolves({
      Items: [
        {
          username: 'alice',
          displayName: 'Alice',
          connections: new Set(['c-orphan']),
          version: 3,
          announcedVersion: 1,
          changedAt: now - REANNOUNCE_DELAY_MS - 1_000,
        },
      ],
    });
    ddbMock.on(GetCommand, { Key: { connectionId: 'c-orphan' } }).resolves({});
    ddbMock
      .on(UpdateCommand, {
        Key: { username: 'alice' },
        UpdateExpression: 'DELETE connections :c ADD version :one SET changedAt = :now',
      })
      .resolves({
        Attributes: {
          username: 'alice',
          displayName: 'Alice',
          connections: new Set(),
          version: 4,
        },
      });
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand, { TableName: 'Memberships' }).resolves({
      Items: [{ username: 'alice', conversationId: 'd:alice:bruno' }],
    });
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: {
          Conversations: [
            { conversationId: 'd:alice:bruno', members: new Set(['alice', 'bruno']) },
          ],
        },
      })
      .resolvesOnce({
        Responses: {
          Users: [
            {
              username: 'bruno',
              displayName: 'Bruno',
              connections: new Set(['c-bruno-1']),
              version: 1,
            },
          ],
        },
      });
    ddbMock
      .on(UpdateCommand, {
        Key: { username: 'alice' },
        UpdateExpression: 'SET announcedVersion = :v',
      })
      .resolves({});

    await presenceSweeper();

    expect(postedEvents()).toEqual([
      {
        connectionId: 'c-bruno-1',
        event: {
          type: 'presence',
          username: 'alice',
          displayName: 'Alice',
          online: false,
          version: 4,
        },
      },
    ]);
  });

  test('presenceSweeper still re-announces a stale user when orphan unbind loses a race', async () => {
    const now = 1_750_000_000_000;
    jest.useFakeTimers({ now });
    ddbMock.on(ScanCommand, { TableName: 'Connections' }).resolves({ Items: [] });
    ddbMock.on(ScanCommand, { TableName: 'Users' }).resolves({
      Items: [
        {
          username: 'alice',
          displayName: 'Alice',
          connections: new Set(['c-orphan']),
          version: 3,
          announcedVersion: 1,
          changedAt: now - REANNOUNCE_DELAY_MS - 1_000,
        },
      ],
    });
    ddbMock.on(GetCommand, { Key: { connectionId: 'c-orphan' } }).resolves({});
    // Another path removed c-orphan from Users.connections before unbind ran, so unbind did not announce.
    ddbMock
      .on(UpdateCommand, {
        Key: { username: 'alice' },
        UpdateExpression: 'DELETE connections :c ADD version :one SET changedAt = :now',
      })
      .rejects(new ConditionalCheckFailedException({ message: 'already removed', $metadata: {} }));
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand, { TableName: 'Memberships' }).resolves({
      Items: [{ username: 'alice', conversationId: 'd:alice:bruno' }],
    });
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: {
          Conversations: [
            { conversationId: 'd:alice:bruno', members: new Set(['alice', 'bruno']) },
          ],
        },
      })
      .resolvesOnce({
        Responses: {
          Users: [
            {
              username: 'bruno',
              displayName: 'Bruno',
              connections: new Set(['c-bruno-1']),
              version: 1,
            },
          ],
        },
      });
    ddbMock
      .on(UpdateCommand, {
        Key: { username: 'alice' },
        UpdateExpression: 'SET announcedVersion = :v',
      })
      .resolves({});

    await presenceSweeper();

    expect(postedEvents()).toEqual([
      {
        connectionId: 'c-bruno-1',
        event: {
          type: 'presence',
          username: 'alice',
          displayName: 'Alice',
          online: true,
          version: 3,
        },
      },
    ]);
  });
});
