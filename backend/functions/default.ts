import { ErrorCode, close, parseBody, sendError, touch, withRequestLog } from './shared';

/** Answers requests with no matching route, including non-JSON ones (RF09). */
export const handler = withRequestLog(async (event) => {
  const { connectionId, requestTimeEpoch: now } = event.requestContext;
  const requestId = parseBody(event.body)?.requestId;
  const username = await touch(connectionId, now);
  const code: ErrorCode = username ? 'unknownAction' : 'notRegistered';
  const message = username
    ? 'No route matches this request.'
    : 'This connection is not registered.';

  // An unregistered connection must close even when the error cannot be sent.
  try {
    const delivered = await sendError(connectionId, username, {
      code,
      message,
      requestId: typeof requestId === 'string' ? requestId : undefined,
    });
    return { result: delivered ? 'error' : 'gone', code };
  } finally {
    if (!username) await close(connectionId);
  }
});
