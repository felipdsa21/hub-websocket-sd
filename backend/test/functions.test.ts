import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import * as app from '../functions/app';
import * as connect from '../functions/connect';
import * as fallback from '../functions/default';
import * as disconnect from '../functions/disconnect';

const db = mockClient(DynamoDBDocumentClient);
const api = mockClient(ApiGatewayManagementApiClient);
const conditionFailed = new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
const REQUEST_ID = '0b6d2c1e-7f0e-4a51-9d3a-1c2f6a8e4b77';

const event = (
  routeKey: string,
  extra: Partial<APIGatewayProxyWebsocketEventV2> = {},
): APIGatewayProxyWebsocketEventV2 =>
  ({
    requestContext: { connectionId: 'c1', routeKey, requestTimeEpoch: Date.now() },
    isBase64Encoded: false,
    ...extra,
  }) as APIGatewayProxyWebsocketEventV2;

const posted = () =>
  api.commandCalls(PostToConnectionCommand).map((c) => JSON.parse(String(c.args[0].input.Data)));

beforeEach(() => {
  db.reset();
  api.reset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('connect', () => {
  test.each([
    [{ username: 'Ana.Silva' }, { username: 'ana.silva', displayName: 'ana.silva' }],
    [
      { username: 'ana', displayName: 'Ana S' },
      { username: 'ana', displayName: 'Ana S' },
    ],
    [{}, undefined],
    [{ username: 'an' }, undefined],
    [{ username: 'a:b' }, undefined],
    [{ username: 'ana', displayName: ' Ana' }, undefined],
    [{ username: 'ana', displayName: 'x'.repeat(51) }, undefined],
  ])('parseIdentity(%j)', (query, expected) => {
    expect(connect.parseIdentity(query)).toEqual(expected);
  });

  test('fails the handshake without a valid username', async () => {
    expect(await connect.handler(event('$connect'))).toEqual({ statusCode: 400 });
    expect(db.calls()).toHaveLength(0);
  });

  test('writes the connection record before adding the id to the user (D09)', async () => {
    const result = await connect.handler(
      event('$connect', { queryStringParameters: { username: 'ana' } }),
    );
    expect(result).toEqual({ statusCode: 200 });
    const [put, update] = db.calls().map((c) => c.args[0]);
    expect(put).toBeInstanceOf(PutCommand);
    expect(update).toBeInstanceOf(UpdateCommand);
    expect((update as UpdateCommand).input.Key).toEqual({ username: 'ana' });
  });
});

describe('disconnect', () => {
  test('removes the id from the user before deleting the record', async () => {
    db.on(GetCommand).resolves({ Item: { connectionId: 'c1', username: 'ana', connectedAt: 0 } });
    await disconnect.handler(event('$disconnect'));
    const commands = db.calls().map((c) => c.args[0].constructor);
    expect(commands).toEqual([GetCommand, UpdateCommand, DeleteCommand]);
  });

  test('still deletes the record when another path already removed the id', async () => {
    db.on(GetCommand).resolves({ Item: { connectionId: 'c1', username: 'ana', connectedAt: 0 } });
    db.on(UpdateCommand).rejects(conditionFailed);
    await disconnect.handler(event('$disconnect'));
    expect(db.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  test('does nothing for a connection already unbound', async () => {
    db.on(GetCommand).resolves({});
    await disconnect.handler(event('$disconnect'));
    expect(db.calls()).toHaveLength(1);
  });
});

describe('app', () => {
  test('answers heartbeat with pong', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    await app.handler(event('heartbeat', { body: JSON.stringify({ requestId: REQUEST_ID }) }));
    expect(posted()).toEqual([{ type: 'pong', requestId: REQUEST_ID }]);
  });

  test('rejects a request without a valid requestId', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    await app.handler(event('heartbeat', { body: '{}' }));
    expect(posted()).toEqual([expect.objectContaining({ type: 'error', code: 'invalidRequest' })]);
  });

  test('answers notRegistered and closes a connection without a record', async () => {
    db.on(UpdateCommand).rejects(conditionFailed);
    await app.handler(event('heartbeat', { body: JSON.stringify({ requestId: REQUEST_ID }) }));
    expect(posted()).toEqual([
      expect.objectContaining({ requestId: REQUEST_ID, code: 'notRegistered' }),
    ]);
    expect(api.commandCalls(DeleteConnectionCommand)).toHaveLength(1);
  });

  test('closes without an error when an unregistered connection sends a message (RF12)', async () => {
    db.on(UpdateCommand).rejects(conditionFailed);
    await app.handler(event('sendMessage', { body: JSON.stringify({ requestId: REQUEST_ID }) }));
    expect(posted()).toEqual([]);
    expect(api.commandCalls(DeleteConnectionCommand)).toHaveLength(1);
  });

  test('unbinds a connection that answers 410 Gone (RF08)', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    db.on(GetCommand).resolves({});
    api.on(PostToConnectionCommand).rejects(new GoneException({ message: 'gone', $metadata: {} }));
    await app.handler(event('heartbeat', { body: JSON.stringify({ requestId: REQUEST_ID }) }));
    expect(db.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});

describe('default', () => {
  test('answers unknownAction with the requestId', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    await fallback.handler(event('$default', { body: JSON.stringify({ requestId: 'r1' }) }));
    expect(posted()).toEqual([expect.objectContaining({ requestId: 'r1', code: 'unknownAction' })]);
  });

  test('answers a non-JSON request', async () => {
    db.on(UpdateCommand).resolves({ Attributes: { username: 'ana' } });
    await fallback.handler(event('$default', { body: 'hello' }));
    expect(posted()).toEqual([expect.objectContaining({ code: 'unknownAction' })]);
  });
});
