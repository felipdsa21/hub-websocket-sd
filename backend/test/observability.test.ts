import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { handler as app } from '../functions/app';
import { handler as connect } from '../functions/connect';
import {
  OPEN_CONNECTIONS_METRIC,
  SECOND_SCAN_DELAY_MS,
  handler as presenceSweeper,
} from '../functions/presenceSweeper';
import { anonymize, resetHmacSecretCache } from '../functions/shared';

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);
const ssmMock = mockClient(SSMClient);
const cwMock = mockClient(CloudWatchClient);

const SECRET = 'test-hmac-secret-value';
const REQ_ID = '11111111-1111-4111-8111-111111111111';
const MSG_ID = '22222222-2222-4222-8222-222222222222';
const CONV_ID = 'g:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let logs: Record<string, unknown>[];

function wsEvent(
  routeKey: string,
  opts: {
    connectionId?: string;
    query?: Record<string, string>;
    body?: unknown;
  } = {},
): APIGatewayProxyWebsocketEventV2 {
  return {
    requestContext: {
      routeKey,
      connectionId: opts.connectionId ?? 'conn-raw-1',
      requestTimeEpoch: Date.now(),
    },
    ...(opts.query && { queryStringParameters: opts.query }),
    ...(opts.body !== undefined && {
      body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    }),
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

beforeEach(() => {
  ddbMock.reset();
  apiMock.reset();
  ssmMock.reset();
  cwMock.reset();
  resetHmacSecretCache();

  process.env.CONNECTIONS_TABLE = 'Connections';
  process.env.USERS_TABLE = 'Users';
  process.env.CONVERSATIONS_TABLE = 'Conversations';
  process.env.MEMBERSHIPS_TABLE = 'Memberships';
  process.env.MESSAGES_TABLE = 'Messages';
  process.env.LOG_HMAC_SECRET_PARAM = '/hub-websocket/dev/log-hmac-secret';
  process.env.METRICS_NAMESPACE = 'HubWebSocket/dev';

  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET } });
  apiMock.on(PostToConnectionCommand).resolves({});
  cwMock.on(PutMetricDataCommand).resolves({});

  logs = [];
  jest.spyOn(console, 'log').mockImplementation((line) => {
    logs.push(JSON.parse(String(line)));
  });
});

afterEach(() => {
  delete process.env.LOG_HMAC_SECRET_PARAM;
  delete process.env.METRICS_NAMESPACE;
  resetHmacSecretCache();
  jest.restoreAllMocks();
});

describe('HMAC log anonymization (RNF03, section 5)', () => {
  test('anonymizes connectionId, username and conversationId with 12-char HMAC-SHA256 and never logs message text', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { username: 'alice' } });
    ddbMock.on(GetCommand).resolves({
      Item: {
        conversationId: CONV_ID,
        type: 'group',
        members: new Set(['alice', 'bruno']),
        started: true,
      },
    });
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        Users: [
          {
            username: 'alice',
            displayName: 'Alice',
            connections: new Set(['conn-secret-id']),
            version: 1,
          },
          {
            username: 'bruno',
            displayName: 'Bruno',
            connections: new Set(['conn-bruno']),
            version: 1,
          },
        ],
      },
    });

    await app(
      wsEvent('sendMessage', {
        connectionId: 'conn-secret-id',
        body: {
          action: 'sendMessage',
          requestId: REQ_ID,
          conversationId: CONV_ID,
          messageId: MSG_ID,
          text: 'segredo-que-nunca-pode-ir-ao-log',
        },
      }),
    );

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(logs).toHaveLength(1);
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain('conn-secret-id');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain(CONV_ID);
    expect(serialized).not.toContain('segredo-que-nunca-pode-ir-ao-log');
    expect(logs[0]).toMatchObject({
      route: 'sendMessage',
      result: 'ok',
      connectionId: anonymize('conn-secret-id', SECRET),
      username: anonymize('alice', SECRET),
      conversationId: anonymize(CONV_ID, SECRET),
    });
    expect(String(logs[0]!.connectionId)).toMatch(/^[0-9a-f]{12}$/);
  });

  test('caches the SSM secret across requests in the same Lambda instance', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await connect(wsEvent('$connect', { connectionId: 'c1', query: { username: 'alice' } }));
    await connect(wsEvent('$connect', { connectionId: 'c2', query: { username: 'alice' } }));

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(logs[0]!.username).toBe(logs[1]!.username);
    expect(logs[0]!.connectionId).not.toBe(logs[1]!.connectionId);
  });

  test('omits raw identifiers if SSM fails instead of leaking them', async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error('SSM unavailable'));
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await connect(wsEvent('$connect', { connectionId: 'c-leak', query: { username: 'bob' } }));

    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain('c-leak');
    expect(serialized).not.toContain('bob');
    expect(logs[0]).toMatchObject({ route: '$connect', result: 'ok' });
  });
});

describe('Authorization and validation checks (RF01, RNF01)', () => {
  test('refuses sendMessage, getHistory, addMember and leaveGroup for a non-member with forbidden', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { username: 'intruso' } });
    ddbMock.on(GetCommand).resolves({
      Item: {
        conversationId: CONV_ID,
        type: 'group',
        members: new Set(['alice', 'bruno']),
        started: true,
      },
    });

    const cases = [
      wsEvent('sendMessage', {
        body: {
          action: 'sendMessage',
          requestId: REQ_ID,
          conversationId: CONV_ID,
          messageId: MSG_ID,
          text: 'hi',
        },
      }),
      wsEvent('getHistory', {
        body: { action: 'getHistory', requestId: REQ_ID, conversationId: CONV_ID },
      }),
      wsEvent('addMember', {
        body: {
          action: 'addMember',
          requestId: REQ_ID,
          conversationId: CONV_ID,
          username: 'carla',
        },
      }),
      wsEvent('leaveGroup', {
        body: { action: 'leaveGroup', requestId: REQ_ID, conversationId: CONV_ID },
      }),
    ];

    for (const ev of cases) {
      await app(ev);
    }

    expect(logs.map((l) => l.code)).toEqual(['forbidden', 'forbidden', 'forbidden', 'forbidden']);
    expect(logs.every((l) => l.username === anonymize('intruso', SECRET))).toBe(true);
  });
});

describe('OpenConnections metric in presenceSweeper (RNF06, section 5)', () => {
  test('publishes the active connection count to CloudWatch', async () => {
    jest.useFakeTimers();
    const now = Date.now();
    ddbMock.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [
        { connectionId: 'c1', lastSeenAt: now - 1000 },
        { connectionId: 'c2', lastSeenAt: now - 2000 },
      ],
    });
    ddbMock.on(ScanCommand, { TableName: 'Users' }).resolves({ Items: [] });

    const run = presenceSweeper();
    await jest.advanceTimersByTimeAsync(SECOND_SCAN_DELAY_MS);
    await run;
    jest.useRealTimers();

    const calls = cwMock.commandCalls(PutMetricDataCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      Namespace: 'HubWebSocket/dev',
      MetricData: [{ MetricName: OPEN_CONNECTIONS_METRIC, Value: 2, Unit: 'Count' }],
    });
  });
});
