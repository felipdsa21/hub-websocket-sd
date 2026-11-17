import { Service, computed, inject } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';
import { HubConfig } from '@/core/hub/hub-config';
import { HubSocket } from '@/core/hub/hub-socket';

export type ConnectionStatus = 'connected' | 'lost';

@Service()
export class ConnectionStore {
  private readonly scenarios = inject(Scenarios);
  private readonly config = inject(HubConfig);
  private readonly socket = inject(HubSocket);

  /**
   * With the backend, the state of the WebSocket connection; with the fixed data, the connection is
   * only lost in the "sem-conexao" scenario.
   */
  public readonly status = computed<ConnectionStatus>(() => {
    if (this.config.live()) {
      return this.socket.status() === 'open' ? 'connected' : 'lost';
    }
    return this.scenarios.has('sem-conexao') ? 'lost' : 'connected';
  });

  public readonly connected = computed(() => this.status() === 'connected');
}
