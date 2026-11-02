import { HubError } from './error';

/** A message confirmed by the backend (architecture, section 4.2). */
export interface Message {
  readonly conversationId: string;
  readonly sk: string;
  readonly messageId: string;
  readonly sender: string;
  readonly text: string;
  readonly sentAt: number;
}

/** A message the backend hasn't confirmed: pending, or rejected with an error (RF12). */
export interface OutgoingMessage {
  readonly conversationId: string;
  readonly messageId: string;
  readonly text: string;
  readonly error?: HubError;
}

export function messageSk(sentAt: number, sender: string, messageId: string): string {
  return `${skInstant(sentAt)}#${sender}#${messageId}`;
}

/** An `sk` after every message sent at the instant, to place something right after them. */
export function skAfterInstant(sentAt: number): string {
  // The highest character sorts after any sender and id.
  return `${skInstant(sentAt)}#\uffff`;
}

function skInstant(sentAt: number): string {
  return `m#${String(sentAt).padStart(13, '0')}`;
}

export function compareMessages(a: Message, b: Message): number {
  return a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0;
}
