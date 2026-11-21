import { DestroyRef, Service, computed, inject, signal } from '@angular/core';
import { HubSocket } from '@/core/hub/hub-socket';
import { Clock } from '@/core/time/clock';

export type TelemetryKind = 'connection' | 'presence' | 'retry' | 'latency';

export interface TelemetryEvent {
  readonly id: number;
  readonly timestamp: number;
  readonly kind: TelemetryKind;
  readonly summary: string;
}

const MAX_EVENTS = 100;
const MAX_RTT_SAMPLES = 20;

/**
 * Keeps recent client events (reconnections, presence, queue retries) and Round-Trip Time
 * measurements for the optional telemetry panel and latency indicator.
 */
@Service()
export class TelemetryStore {
  private readonly socket = inject(HubSocket);
  private readonly clock = inject(Clock);
  private nextId = 1;

  private readonly rttSamples = signal<readonly number[]>([]);
  private readonly eventsSignal = signal<readonly TelemetryEvent[]>([]);

  /** Optional latency badge in the top bar; off by default to keep the interface clean. */
  public readonly showLatency = signal(false);

  public readonly events = this.eventsSignal.asReadonly();
  public readonly lastRttMs = computed<number | null>(() => this.rttSamples().at(-1) ?? null);
  public readonly averageRttMs = computed<number | null>(() => {
    const samples = this.rttSamples();
    if (samples.length === 0) {
      return null;
    }
    const sum = samples.reduce((acc, value) => acc + value, 0);
    return Math.round(sum / samples.length);
  });

  constructor() {
    const sub = this.socket.heartbeatRtt.subscribe((rttMs) => this.recordRtt(rttMs, 'heartbeat'));
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  public record(
    kind: TelemetryKind,
    summary: string,
    timestamp = this.clock.instant().epochMilliseconds,
  ): void {
    const entry: TelemetryEvent = { id: this.nextId++, timestamp, kind, summary };
    this.eventsSignal.update((list) => [entry, ...list].slice(0, MAX_EVENTS));
  }

  public recordRtt(rttMs: number, source: 'heartbeat' | 'message'): void {
    if (!Number.isFinite(rttMs)) {
      return;
    }
    const rounded = Math.max(0, Math.round(rttMs));
    this.rttSamples.update((list) => [...list, rounded].slice(-MAX_RTT_SAMPLES));
    const label = source === 'heartbeat' ? 'Heartbeat' : 'Mensagem';
    this.record('latency', `${label}: ${rounded} ms`);
  }

  public clear(): void {
    this.eventsSignal.set([]);
    this.rttSamples.set([]);
  }

  public reset(): void {
    this.clear();
    this.showLatency.set(false);
  }
}
