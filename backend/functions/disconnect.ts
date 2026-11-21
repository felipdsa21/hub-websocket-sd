import { unbind, withRequestLog } from './shared';

export const handler = withRequestLog(async (event) => {
  const username = await unbind(event.requestContext.connectionId);
  return { result: 'ok', username };
});
