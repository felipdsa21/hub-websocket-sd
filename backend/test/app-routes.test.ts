import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GoneException,
  LimitExceededException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  TransactionConflictException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import * as app from '../functions/app';
import { MAX_GROUP_MEMBERS, SEARCH_MAX_RESULTS } from '../functions/conversations';
import { MARKER_TTL_SECONDS, MAX_TEXT_BYTES } from '../functions/messages';

const db = mockClient(DynamoDBDocumentClient);
const api = mockClient(ApiGatewayManagementApiClient);

const REQ_ID = '0b6d2c1e-7f0e-4a51-9d3a-1c2f6a8e4b77';
const MSG_ID = '5f3c9a10-2b7d-4e8f-a6c1-9d0e7b4a2f13';
const GROUP_ID = 'g:11111111-2222-4333-8444-555555555555';
const DIRECT_ID = 'd:ana:bia';
const NOW = 1_731_542_400_123;

const conditionFailed = new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
const gone = new GoneException({ message: 'gone', $metadata: {} });
const limitExceeded = new LimitExceededException({ message: 'limit', $metadata: {} });
const txConflict = new TransactionConflictException({ message: 'conflict', $metadata: {} });

const txCanceled = (codes: string[], firstItem?: Record<string, { SS?: string[] }>) =>
  new TransactionCanceledException({
    message: 'canceled',
    $metadata: {},
    CancellationReasons: codes.map((Code, i) => ({
      Code,
      ...(i === 0 && firstItem ? { Item: firstItem as never } : {}),
    })),
  });

const event = (routeKey: string, body: Record<string, unknown>, connectionId = 'c1') =>
  ({
    requestContext: { connectionId, routeKey, requestTimeEpoch: NOW },
    isBase64Encoded: false,
    body: JSON.stringify(body),
  }) as APIGatewayProxyWebsocketEventV2;

const sentTo = () =>
  api.commandCalls(PostToConnectionCommand).map((c) => ({
    connectionId: c.args[0].input.ConnectionId,
    payload: JSON.parse(String(c.args[0].input.Data)),
  }));

let logSpy: jest.SpyInstance;

beforeAll(() => {
  process.env.CONNECTIONS_TABLE = 'Connections';
  process.env.USERS_TABLE = 'Users';
  process.env.CONVERSATIONS_TABLE = 'Conversations';
  process.env.MEMBERSHIPS_TABLE = 'Memberships';
  process.env.MESSAGES_TABLE = 'Messages';
});

beforeEach(() => {
  db.reset();
  api.reset();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  logSpy.mockClear();
  jest.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const anaUser = { username: 'ana', displayName: 'Ana', connections: new Set(['c1']), version: 2 };
const biaUser = {
  username: 'bia',
  displayName: 'Bia',
  connections: new Set(['c2', 'c3']),
  version: 3,
};

describe('sendMessage', () => {
  test('persists marker + message with server timestamp, updates summary, and fans out via @connections', async () => {
    db.on(UpdateCommand)
      .resolvesOnce({ Attributes: { username: 'ana' } }) // touch
      .resolvesOnce({}); // lastMessageAt
    db.on(GetCommand).resolves({
      Item: {
        conversationId: DIRECT_ID,
        type: 'direct',
        members: new Set(['ana', 'bia']),
        started: true,
      },
    });
    db.on(TransactWriteCommand).resolves({});
    db.on(BatchGetCommand).resolves({ Responses: { Users: [anaUser, biaUser] } });

    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: '  olá\nlinha 2  ',
      }),
    );

    const tx = db.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(tx.TransactItems).toHaveLength(2);
    expect(tx.TransactItems![0]!.Put!.Item).toEqual({
      conversationId: DIRECT_ID,
      sk: `id#ana#${MSG_ID}`,
      ref: `m#${NOW}#ana#${MSG_ID}`,
      expiresAt: Math.floor(NOW / 1000) + MARKER_TTL_SECONDS,
    });
    expect(tx.TransactItems![1]!.Put!.Item).toEqual({
      conversationId: DIRECT_ID,
      sk: `m#${NOW}#ana#${MSG_ID}`,
      messageId: MSG_ID,
      sender: 'ana',
      text: '  olá\nlinha 2  ',
      sentAt: NOW,
    });
    expect(tx.TransactItems![1]!.Put!.Item).not.toHaveProperty('expiresAt');

    const summaryUpdate = db.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(summaryUpdate.ConditionExpression).toContain('attribute_not_exists(lastMessageAt)');
    expect(summaryUpdate.ConditionExpression).toContain('lastMessageBy < :sender');

    expect(sentTo()).toEqual([
      {
        connectionId: 'c1',
        payload: {
          type: 'message',
          conversationId: DIRECT_ID,
          sk: `m#${NOW}#ana#${MSG_ID}`,
          messageId: MSG_ID,
          sender: 'ana',
          text: '  olá\nlinha 2  ',
          sentAt: NOW,
        },
      },
      {
        connectionId: 'c2',
        payload: expect.objectContaining({ type: 'message', messageId: MSG_ID }),
      },
      {
        connectionId: 'c3',
        payload: expect.objectContaining({ type: 'message', messageId: MSG_ID }),
      },
    ]);
  });

  test('closes silently without notRegistered when sendMessage arrives on unregistered connection', async () => {
    db.on(UpdateCommand).rejects(conditionFailed);
    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: 'oi',
      }),
    );
    expect(sentTo()).toEqual([]);
    expect(api.commandCalls(DeleteConnectionCommand)).toHaveLength(1);
  });

  test('includes messageId when requestId or text validation fails (RF09)', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    await app.handler(
      event('sendMessage', {
        requestId: 'bad',
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: 'oi',
      }),
    );
    expect(sentTo()).toEqual([
      {
        connectionId: 'c1',
        payload: expect.objectContaining({
          type: 'error',
          code: 'invalidRequest',
          messageId: MSG_ID,
          details: { field: 'requestId' },
        }),
      },
    ]);
  });

  test('enforces MAX_TEXT_BYTES UTF-8 limit on sendMessage without writing to DynamoDB (A1)', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    // 16384 'á' chars = 32768 UTF-8 bytes; one extra byte exceeds the 32 KB limit.
    const tooLargeUtf8 = `${'á'.repeat(MAX_TEXT_BYTES / 2)}a`;
    expect(Buffer.byteLength(tooLargeUtf8, 'utf8')).toBe(MAX_TEXT_BYTES + 1);

    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: tooLargeUtf8,
      }),
    );

    expect(db.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sentTo()).toEqual([
      {
        connectionId: 'c1',
        payload: {
          type: 'error',
          requestId: REQ_ID,
          messageId: MSG_ID,
          code: 'invalidRequest',
          message: 'text exceeds the maximum allowed size.',
          details: { field: 'text' },
        },
      },
    ]);

    api.reset();
    db.on(GetCommand).resolves({
      Item: {
        conversationId: DIRECT_ID,
        type: 'direct',
        members: new Set(['ana', 'bia']),
        started: true,
      },
    });
    db.on(TransactWriteCommand).resolves({});
    db.on(BatchGetCommand).resolves({ Responses: { Users: [anaUser, biaUser] } });

    const exactLimit = 'a'.repeat(MAX_TEXT_BYTES);
    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: exactLimit,
      }),
    );
    expect(db.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  test('rejects non-member with forbidden including messageId (RNF01)', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'carlos' } });
    db.on(GetCommand).resolves({
      Item: { conversationId: DIRECT_ID, type: 'direct', members: new Set(['ana', 'bia']) },
    });

    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: 'oi',
      }),
    );

    expect(db.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sentTo()).toEqual([
      {
        connectionId: 'c1',
        payload: expect.objectContaining({
          type: 'error',
          code: 'forbidden',
          requestId: REQ_ID,
          messageId: MSG_ID,
        }),
      },
    ]);
  });

  test('handles resend via idempotency marker without fanning out to others (RF12)', async () => {
    const origSk = `m#${NOW - 5000}#ana#${MSG_ID}`;
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand)
      .resolvesOnce({
        Item: {
          conversationId: DIRECT_ID,
          type: 'direct',
          members: new Set(['ana', 'bia']),
          started: true,
        },
      })
      .resolvesOnce({ Item: { conversationId: DIRECT_ID, sk: `id#ana#${MSG_ID}`, ref: origSk } })
      .resolvesOnce({
        Item: {
          conversationId: DIRECT_ID,
          sk: origSk,
          messageId: MSG_ID,
          sender: 'ana',
          text: 'original',
          sentAt: NOW - 5000,
        },
      });
    db.on(TransactWriteCommand).rejects(txCanceled(['ConditionalCheckFailed', 'None']));

    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: 'original',
      }),
    );

    expect(sentTo()).toEqual([
      {
        connectionId: 'c1',
        payload: {
          type: 'message',
          conversationId: DIRECT_ID,
          sk: origSk,
          messageId: MSG_ID,
          sender: 'ana',
          text: 'original',
          sentAt: NOW - 5000,
        },
      },
    ]);
  });

  test('stays silent on persistent TransactionConflict when marker does not exist', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand)
      .resolvesOnce({
        Item: {
          conversationId: DIRECT_ID,
          type: 'direct',
          members: new Set(['ana', 'bia']),
          started: true,
        },
      })
      .resolvesOnce({}); // no marker
    db.on(TransactWriteCommand).rejects(txCanceled(['TransactionConflict', 'None']));

    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: 'oi',
      }),
    );

    expect(db.commandCalls(TransactWriteCommand)).toHaveLength(4); // 1 initial + 3 retries
    expect(sentTo()).toEqual([]);
  });

  test('does not confirm when persistent TransactionConflict happens updating lastMessageAt', async () => {
    db.on(UpdateCommand)
      .resolvesOnce({ Attributes: { username: 'ana' } }) // touch
      .rejects(txConflict); // lastMessageAt
    db.on(GetCommand).resolves({
      Item: {
        conversationId: DIRECT_ID,
        type: 'direct',
        members: new Set(['ana', 'bia']),
        started: true,
      },
    });
    db.on(TransactWriteCommand).resolves({});

    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: 'oi',
      }),
    );

    expect(sentTo()).toEqual([]);
  });

  test('reveals hidden membership and sends conversationAdded before message on first direct message', async () => {
    db.on(UpdateCommand)
      .resolvesOnce({ Attributes: { username: 'ana' } }) // touch
      .resolvesOnce({}) // lastMessageAt
      .resolvesOnce({}) // reveal bia membership
      .resolvesOnce({}); // mark started = true
    db.on(GetCommand)
      .resolvesOnce({
        Item: {
          conversationId: DIRECT_ID,
          type: 'direct',
          members: new Set(['ana', 'bia']),
          started: false,
        },
      })
      .resolves({
        Item: {
          conversationId: DIRECT_ID,
          type: 'direct',
          members: new Set(['ana', 'bia']),
          started: true,
          lastMessageAt: NOW,
          lastMessageBy: 'ana',
        },
      });
    db.on(TransactWriteCommand).resolves({});
    db.on(BatchGetCommand)
      .resolvesOnce({
        Responses: {
          Memberships: [
            { username: 'ana', conversationId: DIRECT_ID, joinedAt: NOW - 1000 },
            { username: 'bia', conversationId: DIRECT_ID, hidden: true },
          ],
        },
      })
      .resolves({ Responses: { Users: [anaUser, biaUser] } });

    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: 'oi bia',
      }),
    );

    const biaDeliveries = sentTo().filter((d) => d.connectionId === 'c2');
    expect(biaDeliveries.map((d) => d.payload.type)).toEqual(['conversationAdded', 'message']);
    expect(biaDeliveries[0]!.payload.conversation.joinedAt).toBe(NOW);

    // Ensure DynamoDB reserved words `hidden` and `started` use ExpressionAttributeNames.
    const updates = db.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates[2]!.ExpressionAttributeNames).toEqual({ '#hidden': 'hidden' });
    expect(updates[3]!.ExpressionAttributeNames).toEqual({ '#started': 'started' });
  });

  test('unbinds 410 Gone connection and continues delivering to remaining connections', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand)
      .resolvesOnce({
        Item: {
          conversationId: DIRECT_ID,
          type: 'direct',
          members: new Set(['ana', 'bia']),
          started: true,
        },
      })
      .resolvesOnce({
        Item: {
          conversationId: DIRECT_ID,
          type: 'direct',
          members: new Set(['ana', 'bia']),
          started: true,
        },
      })
      .resolvesOnce({}); // unbind lookup
    db.on(TransactWriteCommand).resolves({});
    db.on(BatchGetCommand).resolves({ Responses: { Users: [anaUser, biaUser] } });
    api
      .on(PostToConnectionCommand)
      .resolvesOnce({}) // c1
      .rejectsOnce(gone) // c2
      .resolvesOnce({}); // c3

    await app.handler(
      event('sendMessage', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        messageId: MSG_ID,
        text: 'oi',
      }),
    );

    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(3);
  });
});

describe('getHistory', () => {
  test('rejects before and after together', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    await app.handler(
      event('getHistory', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        before: 'm#1',
        after: 'm#2',
      }),
    );
    expect(sentTo()[0]!.payload).toEqual(
      expect.objectContaining({ type: 'error', code: 'invalidRequest' }),
    );
  });

  test('rejects non-members with forbidden (RNF01)', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand).resolves({});
    await app.handler(event('getHistory', { requestId: REQ_ID, conversationId: DIRECT_ID }));
    expect(sentTo()[0]!.payload).toEqual(
      expect.objectContaining({ type: 'error', code: 'forbidden' }),
    );
  });

  test('caps page at 50 messages and sets hasMore when more items exist', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand).resolves({
      Item: { conversationId: DIRECT_ID, members: new Set(['ana', 'bia']) },
    });
    const items = Array.from({ length: 51 }, (_, i) => ({
      conversationId: DIRECT_ID,
      sk: `m#${String(1000 - i).padStart(13, '0')}#ana#${i}`,
      messageId: String(i),
      sender: 'ana',
      text: 'oi',
      sentAt: 1000 - i,
    }));
    db.on(QueryCommand).resolves({ Items: items });

    await app.handler(event('getHistory', { requestId: REQ_ID, conversationId: DIRECT_ID }));

    const res = sentTo()[0]!.payload.data;
    expect(res.messages).toHaveLength(50);
    expect(res.messages[0].sentAt).toBe(951);
    expect(res.messages[49].sentAt).toBe(1000);
    expect(res.hasMore).toBe(true);
  });

  test('queries before with BETWEEN "m#" and :before, excludes cursor, and reverses batch', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand).resolves({
      Item: { conversationId: DIRECT_ID, members: new Set(['ana', 'bia']) },
    });
    db.on(QueryCommand).resolves({
      Items: [
        {
          conversationId: DIRECT_ID,
          sk: 'm#0000000000300#ana#3',
          messageId: '3',
          sender: 'ana',
          text: '3',
          sentAt: 300,
        },
        {
          conversationId: DIRECT_ID,
          sk: 'm#0000000000200#bia#2',
          messageId: '2',
          sender: 'bia',
          text: '2',
          sentAt: 200,
        },
        {
          conversationId: DIRECT_ID,
          sk: 'm#0000000000100#ana#1',
          messageId: '1',
          sender: 'ana',
          text: '1',
          sentAt: 100,
        },
      ],
    });

    await app.handler(
      event('getHistory', {
        requestId: REQ_ID,
        conversationId: DIRECT_ID,
        before: 'm#0000000000300#ana#3',
      }),
    );

    const q = db.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(q.ConsistentRead).toBe(true);
    expect(q.ScanIndexForward).toBe(false);
    expect(q.KeyConditionExpression).toBe(
      'conversationId = :cid AND sk BETWEEN :mPrefix AND :before',
    );

    expect(sentTo()[0]!.payload).toEqual({
      type: 'response',
      requestId: REQ_ID,
      data: {
        messages: [
          expect.objectContaining({ sk: 'm#0000000000100#ana#1' }),
          expect.objectContaining({ sk: 'm#0000000000200#bia#2' }),
        ],
        hasMore: false,
      },
    });
  });

  test('queries after in ascending order and enforces 28 KB page cap while keeping >= 1 message', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand).resolves({
      Item: { conversationId: DIRECT_ID, members: new Set(['ana', 'bia']) },
    });
    const bigText = 'x'.repeat(20 * 1024);
    db.on(QueryCommand).resolves({
      Items: [
        {
          conversationId: DIRECT_ID,
          sk: 'm#1',
          messageId: '1',
          sender: 'ana',
          text: bigText,
          sentAt: 1,
        },
        {
          conversationId: DIRECT_ID,
          sk: 'm#2',
          messageId: '2',
          sender: 'bia',
          text: bigText,
          sentAt: 2,
        },
      ],
    });

    await app.handler(
      event('getHistory', { requestId: REQ_ID, conversationId: DIRECT_ID, after: 'm#0' }),
    );

    const q = db.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(q.ScanIndexForward).toBe(true);
    expect(q.KeyConditionExpression).toBe('conversationId = :cid AND sk BETWEEN :after AND :mEnd');
    expect(sentTo()[0]!.payload.data.messages).toHaveLength(1);
    expect(sentTo()[0]!.payload.data.hasMore).toBe(true);
  });
});

describe('openDirect & createGroup', () => {
  test('openDirect creates new direct chat with target hidden membership', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(BatchGetCommand).resolves({ Responses: { Users: [anaUser, biaUser] } });
    db.on(TransactWriteCommand).resolves({});

    await app.handler(event('openDirect', { requestId: REQ_ID, username: 'Bia' }));

    const tx = db.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(tx.TransactItems![2]!.Put!.Item).toEqual({
      username: 'bia',
      conversationId: DIRECT_ID,
      hidden: true,
    });
    expect(sentTo()[0]!.payload).toEqual({
      type: 'response',
      requestId: REQ_ID,
      data: {
        conversation: expect.objectContaining({
          conversationId: DIRECT_ID,
          type: 'direct',
          joinedAt: NOW,
        }),
      },
    });
  });

  test('openDirect reveals caller hidden membership when chat already exists', async () => {
    db.on(UpdateCommand)
      .resolvesOnce({ Attributes: { username: 'ana' } }) // touch
      .resolvesOnce({ Attributes: { username: 'ana', conversationId: DIRECT_ID, joinedAt: NOW } });
    db.on(BatchGetCommand).resolves({ Responses: { Users: [anaUser, biaUser] } });
    db.on(TransactWriteCommand).rejects(txCanceled(['ConditionalCheckFailed', 'None', 'None']));
    db.on(GetCommand).resolves({
      Item: {
        conversationId: DIRECT_ID,
        type: 'direct',
        members: new Set(['ana', 'bia']),
        started: false,
      },
    });

    await app.handler(event('openDirect', { requestId: REQ_ID, username: 'bia' }));

    expect(sentTo()[0]!.payload.data.conversation.joinedAt).toBe(NOW);
    expect(db.commandCalls(UpdateCommand)[1]!.args[0].input.ExpressionAttributeNames).toEqual({
      '#hidden': 'hidden',
    });
  });

  test('createGroup returns notFound with details.usernames when any user is missing', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(BatchGetCommand).resolves({ Responses: { Users: [biaUser] } });

    await app.handler(
      event('createGroup', { requestId: REQ_ID, name: 'Time', members: ['bia', 'inexistente'] }),
    );
    expect(sentTo()[0]!.payload).toEqual(
      expect.objectContaining({
        type: 'error',
        code: 'notFound',
        details: { usernames: ['inexistente'] },
      }),
    );
  });

  test('createGroup enforces the 99-member creation limit', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    const tooMany = Array.from({ length: 99 }, (_, i) => `user${i}`);
    await app.handler(
      event('createGroup', { requestId: REQ_ID, name: 'Gigante', members: tooMany }),
    );
    expect(sentTo()[0]!.payload).toEqual(
      expect.objectContaining({
        type: 'error',
        code: 'invalidRequest',
        details: { field: 'members' },
      }),
    );
  });

  test('createGroup creates group, emits conversationAdded to all members, and replies', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(BatchGetCommand).resolves({ Responses: { Users: [anaUser, biaUser] } });
    db.on(TransactWriteCommand).resolves({});

    await app.handler(
      event('createGroup', {
        requestId: REQ_ID,
        name: '  Projeto SD  ',
        members: ['ana', 'bia', 'bia'],
      }),
    );

    const tx = db.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(tx.TransactItems).toHaveLength(3); // 1 conversation + 2 memberships
    const deliveries = sentTo();
    expect(deliveries.filter((d) => d.payload.type === 'conversationAdded')).toHaveLength(3); // c1, c2, c3
    expect(
      deliveries.find((d) => d.payload.type === 'response')!.payload.data.conversation.name,
    ).toBe('Projeto SD');
  });

  test.each(['Time\nSD', 'Time\u0000', 'Time\u007f', 'Time\u202e', '\u2066Time'])(
    'createGroup rejects control and bidi characters in group name (%j) (B6)',
    async (badName) => {
      db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
      await app.handler(
        event('createGroup', { requestId: REQ_ID, name: badName, members: ['bia'] }),
      );
      expect(sentTo()[0]!.payload).toEqual(
        expect.objectContaining({
          type: 'error',
          code: 'invalidRequest',
          details: { field: 'name' },
        }),
      );
    },
  );
});

describe('addMember & leaveGroup', () => {
  test('addMember notifies previous members with memberJoined and new member with conversationAdded', async () => {
    const carlosUser = {
      username: 'carlos',
      displayName: 'Carlos',
      connections: new Set(['c4']),
      version: 1,
    };
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand)
      .resolvesOnce({
        Item: {
          conversationId: GROUP_ID,
          type: 'group',
          name: 'SD',
          members: new Set(['ana', 'bia']),
        },
      })
      .resolvesOnce({
        Item: {
          conversationId: GROUP_ID,
          type: 'group',
          name: 'SD',
          members: new Set(['ana', 'bia', 'carlos']),
        },
      });
    db.on(BatchGetCommand)
      .resolvesOnce({ Responses: { Users: [carlosUser] } })
      .resolvesOnce({ Responses: { Users: [anaUser, biaUser, carlosUser] } });
    db.on(TransactWriteCommand).resolves({});

    await app.handler(
      event('addMember', { requestId: REQ_ID, conversationId: GROUP_ID, username: 'carlos' }),
    );

    expect(sentTo().filter((d) => d.payload.type === 'memberJoined')).toHaveLength(3); // c1, c2, c3
    expect(sentTo().filter((d) => d.payload.type === 'conversationAdded')).toEqual([
      {
        connectionId: 'c4',
        payload: expect.objectContaining({
          type: 'conversationAdded',
          conversation: expect.objectContaining({ conversationId: GROUP_ID, joinedAt: NOW }),
        }),
      },
    ]);
    expect(sentTo().find((d) => d.payload.type === 'response')!.payload.data).toEqual({});
  });

  test('addMember distinguishes forbidden vs invalidOperation from CancellationReasons', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand).resolves({
      Item: { conversationId: GROUP_ID, type: 'group', members: new Set(['ana', 'bia']) },
    });
    db.on(BatchGetCommand).resolves({
      Responses: { Users: [{ username: 'carlos', displayName: 'Carlos', version: 1 }] },
    });
    db.on(TransactWriteCommand).rejects(
      txCanceled(['ConditionalCheckFailed', 'None'], { members: { SS: ['bia', 'carlos'] } }),
    );

    await app.handler(
      event('addMember', { requestId: REQ_ID, conversationId: GROUP_ID, username: 'carlos' }),
    );
    expect(sentTo()[0]!.payload.code).toBe('forbidden');
  });

  test('addMember rejects when group already has 99 members without writing to DynamoDB (M3)', async () => {
    const fullMembers = new Set([
      'ana',
      ...Array.from({ length: MAX_GROUP_MEMBERS - 1 }, (_, i) => `user${i}`),
    ]);
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand).resolves({
      Item: { conversationId: GROUP_ID, type: 'group', name: 'Cheio', members: fullMembers },
    });

    await app.handler(
      event('addMember', { requestId: REQ_ID, conversationId: GROUP_ID, username: 'carlos' }),
    );

    expect(db.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(sentTo()[0]!.payload).toEqual(
      expect.objectContaining({
        type: 'error',
        code: 'invalidOperation',
      }),
    );
  });

  test('addMember guards size(members) < :maxMembers in transaction and handles concurrent fill (M3)', async () => {
    const almostFull = [
      'ana',
      ...Array.from({ length: MAX_GROUP_MEMBERS - 2 }, (_, i) => `user${i}`),
    ];
    const filledConcurrently = [...almostFull, 'diana'];
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand).resolves({
      Item: {
        conversationId: GROUP_ID,
        type: 'group',
        name: 'Quase',
        members: new Set(almostFull),
      },
    });
    db.on(BatchGetCommand).resolves({
      Responses: { Users: [{ username: 'carlos', displayName: 'Carlos', version: 1 }] },
    });
    db.on(TransactWriteCommand).rejects(
      txCanceled(['ConditionalCheckFailed', 'None'], { members: { SS: filledConcurrently } }),
    );

    await app.handler(
      event('addMember', { requestId: REQ_ID, conversationId: GROUP_ID, username: 'carlos' }),
    );

    const tx = db.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(tx.TransactItems![0]!.Update!.ConditionExpression).toContain(
      'size(members) < :maxMembers',
    );
    expect(tx.TransactItems![0]!.Update!.ExpressionAttributeValues).toMatchObject({
      ':maxMembers': MAX_GROUP_MEMBERS,
    });
    expect(sentTo()[0]!.payload).toEqual(
      expect.objectContaining({
        type: 'error',
        code: 'invalidOperation',
      }),
    );
  });

  test('leaveGroup returns lastMember on concurrent leave without confirm', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand).resolves({
      Item: { conversationId: GROUP_ID, type: 'group', members: new Set(['ana', 'bia']) },
    });
    db.on(TransactWriteCommand).rejects(
      txCanceled(['ConditionalCheckFailed', 'None'], { members: { SS: ['ana'] } }),
    );

    await app.handler(event('leaveGroup', { requestId: REQ_ID, conversationId: GROUP_ID }));
    expect(sentTo()[0]!.payload.code).toBe('lastMember');
  });

  test('leaveGroup omits size check with confirm=true and notifies remaining members on normal leave', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand)
      .resolvesOnce({
        Item: { conversationId: GROUP_ID, type: 'group', members: new Set(['ana']) },
      })
      .resolvesOnce({
        Item: { conversationId: GROUP_ID, type: 'group', members: new Set() },
      });
    db.on(TransactWriteCommand).resolves({});
    db.on(BatchGetCommand).resolves({ Responses: { Users: [anaUser] } });

    await app.handler(
      event('leaveGroup', { requestId: REQ_ID, conversationId: GROUP_ID, confirm: true }),
    );
    const tx = db.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(tx.TransactItems![0]!.Update!.ConditionExpression).toBe('contains(members, :me)');
    expect(sentTo().map((d) => d.payload.type)).toEqual(['conversationRemoved', 'response']);
  });

  test('leaveGroup sends memberLeft to remaining members', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand)
      .resolvesOnce({
        Item: { conversationId: GROUP_ID, type: 'group', members: new Set(['ana', 'bia']) },
      })
      .resolvesOnce({
        Item: { conversationId: GROUP_ID, type: 'group', members: new Set(['bia']) },
      });
    db.on(TransactWriteCommand).resolves({});
    db.on(BatchGetCommand).resolves({ Responses: { Users: [anaUser, biaUser] } });

    await app.handler(event('leaveGroup', { requestId: REQ_ID, conversationId: GROUP_ID }));
    expect(sentTo()).toEqual([
      { connectionId: 'c1', payload: { type: 'conversationRemoved', conversationId: GROUP_ID } },
      {
        connectionId: 'c2',
        payload: { type: 'memberLeft', conversationId: GROUP_ID, username: 'ana' },
      },
      {
        connectionId: 'c3',
        payload: { type: 'memberLeft', conversationId: GROUP_ID, username: 'ana' },
      },
      { connectionId: 'c1', payload: { type: 'response', requestId: REQ_ID, data: {} } },
    ]);
  });

  test('addMember waits for both fanOuts to finish even when one fails', async () => {
    const carlosUser = {
      username: 'carlos',
      displayName: 'Carlos',
      connections: new Set(['c4']),
      version: 1,
    };
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand)
      .resolvesOnce({
        Item: {
          conversationId: GROUP_ID,
          type: 'group',
          name: 'SD',
          members: new Set(['ana', 'bia']),
        },
      })
      .resolvesOnce({
        Item: {
          conversationId: GROUP_ID,
          type: 'group',
          name: 'SD',
          members: new Set(['ana', 'bia', 'carlos']),
        },
      });
    db.on(BatchGetCommand)
      .resolvesOnce({ Responses: { Users: [carlosUser] } })
      .resolvesOnce({ Responses: { Users: [anaUser, biaUser, carlosUser] } });
    db.on(TransactWriteCommand).resolves({});

    let resolveTarget!: () => void;
    const pendingTarget = new Promise<object>((resolve) => {
      resolveTarget = () => resolve({});
    });
    api.on(PostToConnectionCommand, { ConnectionId: 'c1' }).rejects(limitExceeded);
    api.on(PostToConnectionCommand, { ConnectionId: 'c4' }).callsFake(() => pendingTarget);

    let settled = false;
    const run = app
      .handler(
        event('addMember', { requestId: REQ_ID, conversationId: GROUP_ID, username: 'carlos' }),
      )
      .finally(() => {
        settled = true;
      });
    const outcome = expect(run).rejects.toThrow(limitExceeded);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    resolveTarget();
    await outcome;
    expect(sentTo().filter((d) => d.payload.type === 'conversationAdded')).toHaveLength(1);
    expect(sentTo().filter((d) => d.payload.type === 'memberJoined')).toHaveLength(3);
  });

  test('leaveGroup waits for both fanOuts to finish even when one fails', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand)
      .resolvesOnce({
        Item: { conversationId: GROUP_ID, type: 'group', members: new Set(['ana', 'bia']) },
      })
      .resolvesOnce({
        Item: { conversationId: GROUP_ID, type: 'group', members: new Set(['bia']) },
      });
    db.on(TransactWriteCommand).resolves({});
    db.on(BatchGetCommand).resolves({ Responses: { Users: [anaUser, biaUser] } });

    let resolveMemberLeft!: () => void;
    const pendingMemberLeft = new Promise<object>((resolve) => {
      resolveMemberLeft = () => resolve({});
    });
    api.on(PostToConnectionCommand, { ConnectionId: 'c1' }).rejects(limitExceeded);
    api.on(PostToConnectionCommand, { ConnectionId: 'c2' }).callsFake(() => pendingMemberLeft);

    let settled = false;
    const run = app
      .handler(event('leaveGroup', { requestId: REQ_ID, conversationId: GROUP_ID }))
      .finally(() => {
        settled = true;
      });
    const outcome = expect(run).rejects.toThrow(limitExceeded);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    resolveMemberLeft();
    await outcome;
    expect(sentTo().filter((d) => d.payload.type === 'memberLeft')).toHaveLength(2);
  });
});

describe('sync & search', () => {
  test('sync omits hidden conversations and marks updated conversations since parameter', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(QueryCommand).resolves({
      Items: [
        { username: 'ana', conversationId: DIRECT_ID, joinedAt: 100 },
        { username: 'ana', conversationId: 'd:ana:hidden', hidden: true },
        { username: 'ana', conversationId: GROUP_ID, joinedAt: 200 },
      ],
    });
    db.on(BatchGetCommand)
      .resolvesOnce({
        Responses: {
          Conversations: [
            {
              conversationId: DIRECT_ID,
              type: 'direct',
              members: new Set(['ana', 'bia']),
              lastMessageAt: 500,
              lastMessageBy: 'bia',
            },
            {
              conversationId: GROUP_ID,
              type: 'group',
              name: 'SD',
              members: new Set(['ana', 'bia']),
              lastMessageAt: 900,
              lastMessageBy: 'ana',
            },
          ],
        },
      })
      .resolvesOnce({ Responses: { Users: [anaUser, biaUser] } });

    await app.handler(event('sync', { requestId: REQ_ID, since: 600 }));

    expect(sentTo()[0]!.payload).toEqual({
      type: 'response',
      requestId: REQ_ID,
      data: {
        serverTime: NOW,
        conversations: [
          expect.objectContaining({ conversationId: GROUP_ID }),
          expect.objectContaining({ conversationId: DIRECT_ID }),
        ],
        updated: [GROUP_ID],
      },
    });
  });

  test('search excludes self and visible direct chat partners from people results and paginates Scan', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(QueryCommand).resolves({
      Items: [{ username: 'ana', conversationId: DIRECT_ID, joinedAt: 100 }],
    });
    db.on(BatchGetCommand).resolves({
      Responses: {
        Conversations: [
          { conversationId: DIRECT_ID, type: 'direct', members: new Set(['ana', 'bia']) },
        ],
      },
    });
    db.on(ScanCommand)
      .resolvesOnce({
        Items: [anaUser, biaUser],
        LastEvaluatedKey: { username: 'bia' },
      })
      .resolvesOnce({
        Items: [{ username: 'bianca', displayName: 'Bianca', version: 1 }],
      });

    await app.handler(event('search', { requestId: REQ_ID, query: 'bi' }));

    expect(sentTo()[0]!.payload).toEqual({
      type: 'response',
      requestId: REQ_ID,
      data: {
        conversations: [expect.objectContaining({ conversationId: DIRECT_ID })],
        people: [{ username: 'bianca', displayName: 'Bianca', online: false, version: 1 }],
      },
    });
  });

  test('search normalizes pt-BR accents and caps conversations and people at 50 each (B8)', async () => {
    const memberships = Array.from({ length: 60 }, (_, i) => ({
      username: 'ana',
      conversationId: `g:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      joinedAt: 100 + i,
    }));
    const conversations = memberships.map((m, i) => ({
      conversationId: m.conversationId,
      type: 'group',
      name: `João Antônio ${i}`,
      members: new Set(['ana', 'bia']),
    }));
    const users = [
      anaUser,
      ...Array.from({ length: 60 }, (_, i) => ({
        username: `joao${String(i).padStart(2, '0')}`,
        displayName: `João Antônio ${i}`,
        version: 1,
      })),
    ];
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(QueryCommand).resolves({ Items: memberships });
    db.on(BatchGetCommand).resolves({ Responses: { Conversations: conversations } });
    db.on(ScanCommand).resolves({ Items: users });

    await app.handler(event('search', { requestId: REQ_ID, query: 'joao antonio' }));

    const data = sentTo()[0]!.payload.data;
    expect(data.conversations).toHaveLength(SEARCH_MAX_RESULTS);
    expect(data.people).toHaveLength(SEARCH_MAX_RESULTS);
    expect(data.conversations[0].name).toContain('João Antônio');
    expect(data.people[0].displayName).toContain('João Antônio');
  });
});
