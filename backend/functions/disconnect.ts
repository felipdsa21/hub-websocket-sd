import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { log, unbind } from './shared';

export async function handler(event: APIGatewayProxyWebsocketEventV2) {
  const started = Date.now();
  await unbind(event.requestContext.connectionId);
  log({ route: '$disconnect', result: 'ok', durationMs: Date.now() - started });
  return { statusCode: 200 };
}
