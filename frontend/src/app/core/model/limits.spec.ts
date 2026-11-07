import { MAX_REQUEST_BYTES, sendMessageRequestBytes } from './limits';

describe('sendMessageRequestBytes', () => {
  const conversationId = 'd:bruno:marina';

  it('counts UTF-8 bytes and JSON escapes of the whole request', () => {
    const base = sendMessageRequestBytes(conversationId, '');
    expect(sendMessageRequestBytes(conversationId, 'a')).toBe(base + 1);
    expect(sendMessageRequestBytes(conversationId, 'ã')).toBe(base + 2);
    expect(sendMessageRequestBytes(conversationId, '"')).toBe(base + 2);
  });

  it('puts a 40 KB message over the limit and one just below it under', () => {
    expect(sendMessageRequestBytes(conversationId, 'x'.repeat(40 * 1024))).toBeGreaterThan(
      MAX_REQUEST_BYTES,
    );
    const room = MAX_REQUEST_BYTES - sendMessageRequestBytes(conversationId, '');
    expect(sendMessageRequestBytes(conversationId, 'x'.repeat(room))).toBe(MAX_REQUEST_BYTES);
  });
});
