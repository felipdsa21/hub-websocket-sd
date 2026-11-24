import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
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
import { OPEN_CONNECTIONS_METRIC, handler as presenceSweeper } from '../functions/presenceSweeper';
import { HMAC_RETRY_DELAY_MS, anonymize, resetHmacSecretCache } from '../functions/shared';

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

  test('omits raw identifiers and warns once while waiting to retry a failed SSM read (RNF03)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    ssmMock.on(GetParameterCommand).rejects(new Error('SSM unavailable'));
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await connect(wsEvent('$connect', { connectionId: 'c-leak-1', query: { username: 'bob' } }));
    await connect(wsEvent('$connect', { connectionId: 'c-leak-2', query: { username: 'bob' } }));

    for (const entry of logs) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain('c-leak');
      expect(serialized).not.toContain('bob');
      expect(entry).toMatchObject({ route: '$connect', result: 'ok' });
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warnSpy.mock.calls[0]![0]))).toMatchObject({
      event: 'hmacSecretUnavailable',
      error: 'Error',
    });
  });

  test('runs handler logic in parallel with getHmacSecret without blocking before log() (RNF03)', async () => {
    let resolveSecret!: (value: { Parameter: { Value: string } }) => void;
    const secretDeferred = new Promise<{ Parameter: { Value: string } }>((resolve) => {
      resolveSecret = resolve;
    });
    ssmMock.on(GetParameterCommand).callsFake(() => secretDeferred);
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    const req = connect(
      wsEvent('$connect', { connectionId: 'c-parallel', query: { username: 'alice' } }),
    );
    await new Promise((r) => setImmediate(r));

    // DynamoDB writes ran while SSM was still pending; only the final log waits for the secret.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
    expect(logs).toHaveLength(0);

    resolveSecret({ Parameter: { Value: SECRET } });
    await req;

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      route: '$connect',
      result: 'ok',
      connectionId: anonymize('c-parallel', SECRET),
      username: anonymize('alice', SECRET),
    });
  });

  test('retries SSM only after the retry delay and then caches', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    ssmMock
      .on(GetParameterCommand)
      .rejectsOnce(new Error('SSM transient'))
      .resolves({ Parameter: { Value: SECRET } });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await connect(wsEvent('$connect', { connectionId: 'c1', query: { username: 'alice' } }));
    await connect(wsEvent('$connect', { connectionId: 'c2', query: { username: 'alice' } }));
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);

    const later = Date.now() + HMAC_RETRY_DELAY_MS;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    await connect(wsEvent('$connect', { connectionId: 'c3', query: { username: 'alice' } }));
    await connect(wsEvent('$connect', { connectionId: 'c4', query: { username: 'alice' } }));

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
    for (const entry of logs.slice(0, 2)) {
      expect(entry).not.toHaveProperty('connectionId');
      expect(entry).not.toHaveProperty('username');
    }
    expect(logs[2]).toMatchObject({
      connectionId: anonymize('c3', SECRET),
      username: anonymize('alice', SECRET),
    });
    expect(logs[3]).toMatchObject({
      connectionId: anonymize('c4', SECRET),
      username: anonymize('alice', SECRET),
    });
  });

  test('bounds the SSM read with an abort signal', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await connect(wsEvent('$connect', { connectionId: 'c1', query: { username: 'alice' } }));

    const [, options] = ssmMock.send.getCall(0).args as unknown[] as [
      unknown,
      { abortSignal?: unknown }?,
    ];
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  test('logs result duplicate with anonymized identifiers on idempotent sendMessage resend', async () => {
    const origSk = `m#1700000000000#alice#${MSG_ID}`;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { username: 'alice' } });
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          conversationId: CONV_ID,
          type: 'group',
          members: new Set(['alice', 'bruno']),
          started: true,
        },
      })
      .resolvesOnce({ Item: { conversationId: CONV_ID, sk: `id#alice#${MSG_ID}`, ref: origSk } })
      .resolvesOnce({
        Item: {
          conversationId: CONV_ID,
          sk: origSk,
          messageId: MSG_ID,
          sender: 'alice',
          text: 'segredo-reenvio',
          sentAt: 1_700_000_000_000,
        },
      });
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'canceled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );

    await app(
      wsEvent('sendMessage', {
        connectionId: 'conn-resend',
        body: {
          action: 'sendMessage',
          requestId: REQ_ID,
          conversationId: CONV_ID,
          messageId: MSG_ID,
          text: 'segredo-reenvio',
        },
      }),
    );

    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain('segredo-reenvio');
    expect(serialized).not.toContain('alice');
    expect(logs[0]).toMatchObject({
      route: 'sendMessage',
      result: 'duplicate',
      connectionId: anonymize('conn-resend', SECRET),
      username: anonymize('alice', SECRET),
      conversationId: anonymize(CONV_ID, SECRET),
    });
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
    const now = Date.now();
    ddbMock.on(ScanCommand, { TableName: 'Connections' }).resolves({
      Items: [
        { connectionId: 'c1', lastSeenAt: now - 1000 },
        { connectionId: 'c2', lastSeenAt: now - 2000 },
      ],
    });
    ddbMock.on(ScanCommand, { TableName: 'Users' }).resolves({ Items: [] });

    await presenceSweeper();

    const calls = cwMock.commandCalls(PutMetricDataCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      Namespace: 'HubWebSocket/dev',
      MetricData: [{ MetricName: OPEN_CONNECTIONS_METRIC, Value: 2, Unit: 'Count' }],
    });
  });
});
