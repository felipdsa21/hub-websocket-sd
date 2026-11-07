import { Service, computed, inject, signal } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';

export type ConnectionStatus = 'connected' | 'lost';

@Service()
export class ConnectionStore {
  private readonly scenarios = inject(Scenarios);

  /** With the fixed data, the connection is only lost in the "sem-conexao" scenario. */
  public readonly status = signal<ConnectionStatus>(
    this.scenarios.has('sem-conexao') ? 'lost' : 'connected',
  );

  public readonly connected = computed(() => this.status() === 'connected');
}
