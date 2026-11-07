import { unbind, withRequestLog } from './shared';

export const handler = withRequestLog(async (event) => {
  await unbind(event.requestContext.connectionId);
  return { result: 'ok' };
});
