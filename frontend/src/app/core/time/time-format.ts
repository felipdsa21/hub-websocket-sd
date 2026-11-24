import { Temporal } from 'temporal-polyfill';

export interface TimeContext {
  readonly now: Temporal.Instant;
  readonly timeZone: string;
}

const LOCALE = 'pt-BR';

const formatOptions = {
  time: { hour: '2-digit', minute: '2-digit' },
  weekday: { weekday: 'short' },
  dayMonth: { day: '2-digit', month: '2-digit' },
  dayMonthYear: { day: '2-digit', month: '2-digit', year: 'numeric' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

type FormatKind = keyof typeof formatOptions;

const formatters = new Map<string, Intl.DateTimeFormat>();

function format(kind: FormatKind, epochMilliseconds: number, timeZone: string): string {
  const key = `${kind}|${timeZone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, { ...formatOptions[kind], timeZone });
    formatters.set(key, formatter);
  }
  return formatter.format(epochMilliseconds);
}

export function plainDateOf(epochMilliseconds: number, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(epochMilliseconds)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
}

export function isSameDay(a: number, b: number, timeZone: string): boolean {
  return plainDateOf(a, timeZone).equals(plainDateOf(b, timeZone));
}

/**
 * Calendar days between the instant and now, in the local time zone. An instant slightly ahead of
 * the local clock, as two clocks can differ, counts as today.
 */
export function calendarDaysAgo(epochMilliseconds: number, context: TimeContext): number {
  const today = context.now.toZonedDateTimeISO(context.timeZone).toPlainDate();
  const days = plainDateOf(epochMilliseconds, context.timeZone).until(today, {
    largestUnit: 'days',
  }).days;
  return Math.max(0, days);
}

export function timeLabel(epochMilliseconds: number, timeZone: string): string {
  return format('time', epochMilliseconds, timeZone);
}

/** Day and month, with the year when it isn't the current one. */
export function dateLabel(epochMilliseconds: number, context: TimeContext): string {
  const sameYear =
    plainDateOf(epochMilliseconds, context.timeZone).year ===
    context.now.toZonedDateTimeISO(context.timeZone).year;
  return format(sameYear ? 'dayMonth' : 'dayMonthYear', epochMilliseconds, context.timeZone);
}

/** The time of a conversation's last message in the list. */
export function conversationTimeLabel(epochMilliseconds: number, context: TimeContext): string {
  const days = calendarDaysAgo(epochMilliseconds, context);
  if (days === 0) {
    return timeLabel(epochMilliseconds, context.timeZone);
  }
  if (days === 1) {
    return 'Ontem';
  }
  if (days <= 6) {
    return format('weekday', epochMilliseconds, context.timeZone);
  }
  return dateLabel(epochMilliseconds, context);
}

export function daySeparatorLabel(epochMilliseconds: number, context: TimeContext): string {
  const days = calendarDaysAgo(epochMilliseconds, context);
  if (days === 0) {
    return 'Hoje';
  }
  if (days === 1) {
    return 'Ontem';
  }
  return dateLabel(epochMilliseconds, context);
}
