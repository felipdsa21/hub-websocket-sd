import { Provider } from '@angular/core';
import { Temporal } from 'temporal-polyfill';
import { Clock } from '@/core/time/clock';
import { Scenario, Scenarios } from './scenarios';

export const TEST_TIME_ZONE = 'America/Sao_Paulo';

/**
 * Providers for tests on the fixed data: a clock at the given local time, which moves one second on
 * each read as real actions happen at different instants, and the given scenarios.
 */
export function provideTestFixtures(
  options: { readonly scenarios?: readonly Scenario[]; readonly now?: string } = {},
): Provider[] {
  const scenarios = options.scenarios ?? [];
  const now = Temporal.PlainDateTime.from(options.now ?? '2026-11-02T09:46')
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
    {
      provide: Scenarios,
      useValue: { has: (s: Scenario) => scenarios.includes(s), any: () => scenarios.length > 0 },
    },
  ];
}
