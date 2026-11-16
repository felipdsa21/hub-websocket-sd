import { Service, computed, inject, signal } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';

/** Where the configuration is served from; it stays out of Git, as the address isn't public. */
export const CONFIG_PATH = 'config.json';

/**
 * The backend address, read from `config.json` when the app starts. Without it, or with a scenario
 * chosen in the URL, the client runs on the fixed data.
 */
@Service()
export class HubConfig {
  private readonly scenarios = inject(Scenarios);
  private readonly url = signal<string | null>(null);

  public readonly websocketUrl = this.url.asReadonly();

  /** True when the client talks to the backend instead of the fixed data. */
  public readonly live = computed(() => this.url() !== null && !this.scenarios.any());

  public async load(fetchConfig: typeof fetch = fetch): Promise<void> {
    try {
      const response = await fetchConfig(CONFIG_PATH, { cache: 'no-store' });
      if (!response.ok) {
        return;
      }
      const body: unknown = await response.json();
      this.use(body);
    } catch {
      // No configuration: the fixed data is used.
    }
  }

  /** Takes the address from a parsed configuration, if it is a WebSocket URL. */
  public use(body: unknown): void {
    const url = (body as { websocketUrl?: unknown } | null)?.websocketUrl;
    if (typeof url === 'string' && /^wss?:\/\//.test(url)) {
      this.url.set(url);
    } else {
      console.warn(`${CONFIG_PATH} has no valid websocketUrl; using the fixed data.`);
    }
  }
}
