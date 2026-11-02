import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { close, log, parseBody, send, touch } from './shared';

/** Answers requests with no matching route, including non-JSON ones (RF09). */
export async function handler(event: APIGatewayProxyWebsocketEventV2) {
  const { connectionId, requestTimeEpoch: now } = event.requestContext;
  const requestId = parseBody(event.body)?.requestId;
  const username = await touch(connectionId, now);
  const code = username ? 'unknownAction' : 'notRegistered';

  await send(connectionId, username ?? '', {
    type: 'error',
    ...(typeof requestId === 'string' && { requestId }),
    code,
    message: username ? 'No route matches this request.' : 'This connection is not registered.',
  });
  if (!username) await close(connectionId);

  log({ route: '$default', result: 'error', code, durationMs: Date.now() - now });
  return { statusCode: 200 };
}
