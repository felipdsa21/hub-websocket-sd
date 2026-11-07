import { Temporal } from 'temporal-polyfill';
import {
  TimeContext,
  calendarDaysAgo,
  conversationTimeLabel,
  daySeparatorLabel,
  isSameDay,
  timeLabel,
} from './time-format';

const SAO_PAULO = 'America/Sao_Paulo';

function at(isoDateTime: string, timeZone = SAO_PAULO): number {
  return Temporal.PlainDateTime.from(isoDateTime).toZonedDateTime(timeZone).epochMilliseconds;
}

function contextAt(isoDateTime: string, timeZone = SAO_PAULO): TimeContext {
  return { now: Temporal.Instant.fromEpochMilliseconds(at(isoDateTime, timeZone)), timeZone };
}

describe('time format', () => {
  // Monday, 02/11/2026, half an hour after midnight.
  const context = contextAt('2026-11-02T00:30');

  it('counts calendar days, not 24-hour periods', () => {
    expect(calendarDaysAgo(at('2026-11-01T23:50'), context)).toBe(1);
    expect(calendarDaysAgo(at('2026-11-02T00:10'), context)).toBe(0);
  });

  it('counts an instant ahead of the local clock as today', () => {
    expect(calendarDaysAgo(at('2026-11-02T00:31'), context)).toBe(0);
  });

  it('keeps counting days across a daylight saving change', () => {
    const newYork = 'America/New_York';
    // 01/11/2026 has 25 hours in New York.
    const nyContext = contextAt('2026-11-02T00:30', newYork);
    expect(calendarDaysAgo(at('2026-11-01T00:10', newYork), nyContext)).toBe(1);
    expect(calendarDaysAgo(at('2026-10-31T23:50', newYork), nyContext)).toBe(2);
  });

  it('labels the list time as time, yesterday, weekday or date', () => {
    expect(conversationTimeLabel(at('2026-11-02T00:05'), context)).toBe('00:05');
    expect(conversationTimeLabel(at('2026-11-01T18:20'), context)).toBe('Ontem');
    expect(conversationTimeLabel(at('2026-10-30T12:00'), context)).toBe('sex.');
    expect(conversationTimeLabel(at('2026-10-27T12:00'), context)).toBe('ter.');
    expect(conversationTimeLabel(at('2026-10-26T12:00'), context)).toBe('26/10');
    expect(conversationTimeLabel(at('2025-12-31T12:00'), context)).toBe('31/12/2025');
  });

  it('labels the day separator as today, yesterday or date', () => {
    expect(daySeparatorLabel(at('2026-11-02T00:05'), context)).toBe('Hoje');
    expect(daySeparatorLabel(at('2026-11-01T09:00'), context)).toBe('Ontem');
    expect(daySeparatorLabel(at('2026-10-30T09:00'), context)).toBe('30/10');
  });

  it('formats the time in the given time zone', () => {
    expect(timeLabel(at('2026-11-01T09:05'), SAO_PAULO)).toBe('09:05');
  });

  it('compares days in the given time zone', () => {
    expect(isSameDay(at('2026-11-01T23:59'), at('2026-11-02T00:00'), SAO_PAULO)).toBe(false);
    expect(isSameDay(at('2026-11-01T00:00'), at('2026-11-01T23:59'), SAO_PAULO)).toBe(true);
  });
});
