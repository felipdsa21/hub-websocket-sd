import { Message, OutgoingMessage } from '@/core/model/message';
import { MemberNotice } from '@/core/model/notice';
import { UserState } from '@/core/model/user';
import { TimeContext, daySeparatorLabel, isSameDay, timeLabel } from '@/core/time/time-format';
import { repeatedDisplayNames } from '@/shared/format/display-names';
import { messageErrorReason } from '@/shared/format/error-messages';
import { AvatarKind } from '@/shared/ui/avatar/avatar';

/** Consecutive messages of the same sender within this interval are grouped (design note). */
export const GROUP_INTERVAL_MS = 5 * 60 * 1000;

export type TimelineItem =
  | { readonly kind: 'start'; readonly key: string }
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | { readonly kind: 'notice'; readonly key: string; readonly text: string }
  | TimelineMessage;

export interface TimelineMessage {
  readonly kind: 'message';
  readonly key: string;
  readonly own: boolean;
  /** The first of a group shows the sender (others) or the time above (own). */
  readonly first: boolean;
  readonly text: string;
  readonly time?: string;
  readonly sender?: {
    readonly label: string;
    readonly avatarKind: AvatarKind;
    readonly name: string;
  };
  readonly status?: { readonly pending: true; readonly text: string } | OutgoingError;
}

interface OutgoingError {
  readonly pending: false;
  readonly text: string;
  readonly messageId: string;
}

export interface TimelineInput {
  readonly messages: readonly Message[];
  readonly outgoing: readonly OutgoingMessage[];
  readonly notices: readonly MemberNotice[];
  /** Whether the first loaded page is the start of the conversation. */
  readonly atStart: boolean;
  readonly me: string;
  readonly users: ReadonlyMap<string, UserState>;
  readonly connected: boolean;
  readonly time: TimeContext;
}

export function buildTimeline(input: TimelineInput): TimelineItem[] {
  const items: TimelineItem[] = [];
  if (input.atStart) {
    items.push({ kind: 'start', key: 'start' });
  }

  const senders = new Set(input.messages.map((m) => m.sender));
  const repeated = repeatedDisplayNames(
    [...senders].map((s) => input.users.get(s)).filter((u) => u !== undefined),
  );
  const notices = [...input.notices];
  const firstSk = input.messages[0]?.sk;
  // Notices before the first loaded message only show when the start is loaded.
  const leading = notices.filter(
    (n) => n.afterSk === undefined || (firstSk && n.afterSk < firstSk),
  );
  if (input.atStart) {
    items.push(...leading.map((n) => noticeItem(n, input.users)));
  }
  let pending = notices.filter((n) => !leading.includes(n));

  let previousSentAt: number | undefined;
  /** The message the next one may join; a separator or a notice in between starts a new group. */
  let groupWith: Message | undefined;
  for (const message of input.messages) {
    if (
      previousSentAt === undefined ||
      !isSameDay(previousSentAt, message.sentAt, input.time.timeZone)
    ) {
      items.push({
        kind: 'day',
        key: `day-${message.sk}`,
        label: daySeparatorLabel(message.sentAt, input.time),
      });
      groupWith = undefined;
    }
    const grouped =
      groupWith !== undefined &&
      groupWith.sender === message.sender &&
      message.sentAt - groupWith.sentAt <= GROUP_INTERVAL_MS;
    items.push(messageItem(message, !grouped, input, repeated));
    previousSentAt = message.sentAt;
    groupWith = message;

    const after = pending.filter((n) => n.afterSk !== undefined && n.afterSk <= message.sk);
    if (after.length > 0) {
      items.push(...after.map((n) => noticeItem(n, input.users)));
      pending = pending.filter((n) => !after.includes(n));
      groupWith = undefined;
    }
  }
  items.push(...pending.map((n) => noticeItem(n, input.users)));

  // Unconfirmed messages stay at the end, without a time (design note, RF12).
  for (const message of input.outgoing) {
    items.push({
      kind: 'message',
      key: `out-${message.messageId}`,
      own: true,
      first: false,
      text: message.text,
      status: message.error
        ? {
            pending: false,
            text: `Não enviada: ${messageErrorReason(message.error)}`,
            messageId: message.messageId,
          }
        : { pending: true, text: input.connected ? 'Enviando…' : 'Aguardando conexão' },
    });
  }
  return items;
}

function messageItem(
  message: Message,
  first: boolean,
  input: TimelineInput,
  repeated: ReadonlySet<string>,
): TimelineMessage {
  const own = message.sender === input.me;
  const user = input.users.get(message.sender);
  return {
    kind: 'message',
    key: message.sk,
    own,
    first,
    text: message.text,
    time: timeLabel(message.sentAt, input.time.timeZone),
    sender:
      own || !first
        ? undefined
        : {
            label: !user
              ? `@${message.sender}`
              : repeated.has(user.displayName)
                ? `${user.displayName} · @${user.username}`
                : user.displayName,
            avatarKind: user ? 'person' : 'unknown',
            name: user?.displayName ?? '',
          },
  };
}

function noticeItem(notice: MemberNotice, users: ReadonlyMap<string, UserState>): TimelineItem {
  const name = users.get(notice.username)?.displayName ?? `@${notice.username}`;
  return {
    kind: 'notice',
    key: `notice-${notice.id}`,
    text: notice.kind === 'joined' ? `${name} entrou no grupo` : `${name} saiu do grupo`,
  };
}
