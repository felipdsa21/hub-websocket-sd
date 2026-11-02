import { DOCUMENT, DestroyRef, Service, computed, inject, signal } from '@angular/core';
import { Temporal } from 'temporal-polyfill';
import { TimeContext } from './time-format';

@Service()
export class Clock {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  private readonly nowSignal = signal(Temporal.Now.instant());
  private readonly timeZoneSignal = signal(Temporal.Now.timeZoneId());
  private midnightTimer?: ReturnType<typeof setTimeout>;

  /**
   * Reference instant for relative labels such as "Hoje" and "Ontem". It only needs to change when
   * the day does, so it is refreshed at local midnight and when the tab becomes visible again,
   * since timers run late while the computer sleeps.
   */
  public readonly now = this.nowSignal.asReadonly();
  public readonly timeZone = this.timeZoneSignal.asReadonly();
  public readonly context = computed<TimeContext>(() => ({
    now: this.now(),
    timeZone: this.timeZone(),
  }));

  constructor() {
    const onVisibilityChange = () => {
      if (this.document.visibilityState === 'visible') {
        this.refresh();
      }
    };
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    this.scheduleMidnight();
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.midnightTimer);
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  /** The current instant, for timestamps such as a sent message's. */
  public instant(): Temporal.Instant {
    return Temporal.Now.instant();
  }

  private refresh(): void {
    this.nowSignal.set(Temporal.Now.instant());
    this.timeZoneSignal.set(Temporal.Now.timeZoneId());
    this.scheduleMidnight();
  }

  private scheduleMidnight(): void {
    clearTimeout(this.midnightTimer);
    const now = this.now().toZonedDateTimeISO(this.timeZone());
    const midnight = now.toPlainDate().add({ days: 1 }).toZonedDateTime(this.timeZone());
    this.midnightTimer = setTimeout(
      () => this.refresh(),
      midnight.epochMilliseconds - now.epochMilliseconds,
    );
  }
}
