import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { ErrorCode, UUID, close, log, parseBody, send, touch } from './shared';

/** Serves every application route, chosen by routeKey (D02). */
export async function handler(event: APIGatewayProxyWebsocketEventV2) {
  const { connectionId, routeKey, requestTimeEpoch: now } = event.requestContext;
  const body = parseBody(event.body) ?? {};
  const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
  const fail = async (owner: string, code: ErrorCode, message: string) => {
    await send(connectionId, owner, {
      type: 'error',
      ...(requestId && { requestId }),
      code,
      message,
    });
    log({ route: routeKey, result: 'error', code, durationMs: Date.now() - now });
  };

  const username = await touch(connectionId, now);
  if (!username) {
    // An error would drop a message from the client's queue; closing makes it reconnect and resend (RF12).
    if (routeKey !== 'sendMessage')
      await fail('', 'notRegistered', 'This connection is not registered.');
    else log({ route: routeKey, result: 'closed', durationMs: Date.now() - now });
    await close(connectionId);
    return { statusCode: 200 };
  }
  if (!requestId || !UUID.test(requestId)) {
    await fail(username, 'invalidRequest', 'requestId must be a UUID v4.');
    return { statusCode: 200 };
  }

  switch (routeKey) {
    case 'heartbeat':
      await send(connectionId, username, { type: 'pong', requestId });
      break;
    default:
      throw new Error(`Route ${routeKey} is wired to app but not implemented`);
  }

  log({ route: routeKey, result: 'ok', durationMs: Date.now() - now });
  return { statusCode: 200 };
}
