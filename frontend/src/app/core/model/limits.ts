/** Largest request the web client sends; the API Gateway frame limit (RF11, L03). */
export const MAX_REQUEST_BYTES = 32 * 1024;

const UUID_LENGTH_PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const encoder = new TextEncoder();

/** Size in bytes of the `sendMessage` request that would carry the text (architecture, 4.1). */
export function sendMessageRequestBytes(conversationId: string, text: string): number {
  const request = {
    action: 'sendMessage',
    requestId: UUID_LENGTH_PLACEHOLDER,
    conversationId,
    messageId: UUID_LENGTH_PLACEHOLDER,
    text,
  };
  return encoder.encode(JSON.stringify(request)).length;
}
