import {
  ErrorCode,
  Outcome,
  UUID,
  close,
  parseBody,
  send,
  sendError,
  touch,
  withRequestLog,
} from './shared';

/** Serves every application route, chosen by routeKey (D02). */
export const handler = withRequestLog(async (event) => {
  const { connectionId, routeKey, requestTimeEpoch: now } = event.requestContext;
  const body = parseBody(event.body) ?? {};
  const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
  const fail = async (
    username: string | undefined,
    code: ErrorCode,
    message: string,
  ): Promise<Outcome> => {
    const delivered = await sendError(connectionId, username, { code, message, requestId });
    return { result: delivered ? 'error' : 'gone', code };
  };

  const username = await touch(connectionId, now);
  if (!username) {
    // The connection must close even when the error cannot be sent, so the client reconnects and registers again.
    try {
      return await fail(undefined, 'notRegistered', 'This connection is not registered.');
    } finally {
      await close(connectionId);
    }
  }
  if (!requestId || !UUID.test(requestId)) {
    return fail(username, 'invalidRequest', 'requestId must be a UUID v4.');
  }

  switch (routeKey) {
    case 'heartbeat': {
      const delivered = await send(connectionId, username, { type: 'pong', requestId });
      return { result: delivered ? 'ok' : 'gone' };
    }
    default:
      throw new Error(`Route ${routeKey} is wired to app but not implemented`);
  }
});
