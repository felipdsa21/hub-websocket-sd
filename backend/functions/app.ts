import {
  handleAddMember,
  handleCreateGroup,
  handleLeaveGroup,
  handleOpenDirect,
  handleSearch,
  handleSync,
} from './conversations';
import { RequestContext } from './data';
import { handleGetHistory, handleSendMessage } from './messages';
import {
  ErrorCode,
  ErrorDetails,
  Outcome,
  UUID,
  close,
  parseBody,
  send,
  sendError,
  sendResponse,
  touch,
  withRequestLog,
} from './shared';

/** Serves every application route, chosen by routeKey (D02). */
export const handler = withRequestLog(async (event) => {
  const { connectionId, routeKey, requestTimeEpoch: now } = event.requestContext;
  const body = parseBody(event.body) ?? {};
  const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
  const rawMessageId =
    routeKey === 'sendMessage' && typeof body.messageId === 'string' && body.messageId
      ? body.messageId
      : undefined;

  const fail = async (
    owner: string | undefined,
    code: ErrorCode,
    message: string,
    details?: ErrorDetails,
    messageId = rawMessageId,
  ): Promise<Outcome> => {
    const delivered = await sendError(connectionId, owner, {
      code,
      message,
      requestId,
      messageId,
      details,
    });
    return { result: delivered ? 'error' : 'gone', code };
  };

  const username = await touch(connectionId, now);
  if (!username) {
    // sendMessage closes silently so the client keeps the message pending and retries after reconnecting (RF12).
    if (routeKey === 'sendMessage') {
      await close(connectionId);
      return { result: 'rejected', code: 'notRegistered' };
    }
    try {
      return await fail(undefined, 'notRegistered', 'This connection is not registered.');
    } finally {
      await close(connectionId);
    }
  }

  if (!requestId || !UUID.test(requestId)) {
    return fail(username, 'invalidRequest', 'requestId must be a UUID v4.', { field: 'requestId' });
  }

  if (routeKey === 'heartbeat') {
    const delivered = await send(connectionId, username, { type: 'pong', requestId });
    return { result: delivered ? 'ok' : 'gone' };
  }

  const ctx: RequestContext = {
    connectionId,
    username,
    requestId,
    now,
    body,
    fail: (code, message, details, messageId) =>
      fail(username, code, message, details, messageId ?? rawMessageId),
    reply: async (data) => {
      const delivered = await sendResponse(connectionId, username, requestId, data);
      return { result: delivered ? 'ok' : 'gone' };
    },
  };

  switch (routeKey) {
    case 'sync':
      return handleSync(ctx);
    case 'sendMessage':
      return handleSendMessage(ctx);
    case 'openDirect':
      return handleOpenDirect(ctx);
    case 'createGroup':
      return handleCreateGroup(ctx);
    case 'addMember':
      return handleAddMember(ctx);
    case 'leaveGroup':
      return handleLeaveGroup(ctx);
    case 'getHistory':
      return handleGetHistory(ctx);
    case 'search':
      return handleSearch(ctx);
    default:
      throw new Error(`Route ${routeKey} is wired to app but not implemented`);
  }
});
