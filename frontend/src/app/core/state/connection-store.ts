import { DestroyRef, Service, computed, inject, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { HubSocket } from '@/core/hub/hub-socket';

export type ConnectionStatus = 'connected' | 'lost';

/** A drop is only shown to the user if reconnection doesn't finish within 3 s (section 4.6). */
export const LOSS_INDICATION_MS = 3_000;

@Service()
export class ConnectionStore {
  private readonly socket = inject(HubSocket);

  private readonly reconnecting = signal(false);
  private readonly lossIndicatedSignal = signal(false);
  private readonly reconnectedSubject = new Subject<void>();
  private lossTimer?: ReturnType<typeof setTimeout>;

  /** Fires when reconnection finishes after a drop that was already indicated to the user (RF08). */
  public readonly reconnected: Observable<void> = this.reconnectedSubject.asObservable();

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.lossTimer));
  }

  /**
   * Open and synced; actions that need the backend are disabled as soon as the connection drops,
   * even before the drop is indicated (architecture, section 4.6).
   */
  public readonly status = computed<ConnectionStatus>(() =>
    this.socket.status() === 'open' && !this.reconnecting() ? 'connected' : 'lost',
  );

  public readonly connected = computed(() => this.status() === 'connected');

  /** True when the drop banner is shown and others' presence is hidden (RF07, RF08). */
  public readonly lossIndicated = this.lossIndicatedSignal.asReadonly();

  /** Others' presence stays visible during a short drop (<= 3 s) and returns after `sync`. */
  public readonly presenceVisible = computed(() => !this.lossIndicated());

  /** Starts the 3 s grace window before indicating the drop and hiding presence. */
  public markLost(): void {
    if (this.reconnecting()) {
      return;
    }
    this.reconnecting.set(true);
    clearTimeout(this.lossTimer);
    this.lossTimer = setTimeout(() => {
      this.lossTimer = undefined;
      if (this.reconnecting()) {
        this.lossIndicatedSignal.set(true);
      }
    }, LOSS_INDICATION_MS);
  }

  /** Ends a reconnection after its `sync` answers; signals recovery if the drop was indicated. */
  public markRecovered(): void {
    clearTimeout(this.lossTimer);
    this.lossTimer = undefined;
    const wasIndicated = this.lossIndicatedSignal();
    this.reconnecting.set(false);
    this.lossIndicatedSignal.set(false);
    if (wasIndicated) {
      this.reconnectedSubject.next();
    }
  }

  /** Clears reconnection state on a fresh entry or sign-out. */
  public reset(): void {
    clearTimeout(this.lossTimer);
    this.lossTimer = undefined;
    this.reconnecting.set(false);
    this.lossIndicatedSignal.set(false);
  }
}
