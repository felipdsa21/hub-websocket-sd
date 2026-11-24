import { Provider } from '@angular/core';
import { Temporal } from 'temporal-polyfill';
import { Clock } from './clock';

export const TEST_TIME_ZONE = 'America/Sao_Paulo';

/**
 * A clock fixed at 2026-11-02 09:46 in São Paulo whose `instant()` moves one second on each read,
 * as real actions happen at different instants.
 */
export function provideTestClock(): Provider[] {
  const now = Temporal.PlainDateTime.from('2026-11-02T09:46')
    .toZonedDateTime(TEST_TIME_ZONE)
    .toInstant();
  let ticks = 0;
  return [
    {
      provide: Clock,
      useValue: {
        context: () => ({ now, timeZone: TEST_TIME_ZONE }),
        instant: () => now.add({ seconds: ++ticks }),
      },
    },
  ];
}
