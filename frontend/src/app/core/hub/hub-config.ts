import { InjectionToken, Service, computed, inject, isDevMode, signal } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';

/** Where the configuration is served from; it stays out of Git, as the address isn't public. */
export const CONFIG_PATH = 'config.json';

/** Whether the app runs in development, where the fixed data and `ws://` are allowed. */
export const DEV_MODE = new InjectionToken<boolean>('DEV_MODE', { factory: () => isDevMode() });

/**
 * The backend address, read from `config.json` when the app starts. In development, without it or
 * with a scenario chosen in the URL, the client runs on the fixed data. In a published build, the
 * fixed data is never used: a missing or invalid configuration makes entering fail (RNF07).
 */
@Service()
export class HubConfig {
  private readonly scenarios = inject(Scenarios);
  private readonly devMode = inject(DEV_MODE);
  private readonly url = signal<string | null>(null);
  private readonly invalidSignal = signal(false);

  public readonly websocketUrl = this.url.asReadonly();

  /** True when the client talks to the backend instead of the fixed data. */
  public readonly live = computed(() => this.url() !== null && !this.scenarios.any());

  /** True in a published build without a valid address: entering fails instead of faking it. */
  public readonly invalid = this.invalidSignal.asReadonly();

  public async load(fetchConfig: typeof fetch = fetch): Promise<void> {
    let body: unknown;
    try {
      const response = await fetchConfig(CONFIG_PATH, { cache: 'no-store' });
      if (!response.ok) {
        this.reject(`${CONFIG_PATH} answered ${response.status}.`);
        return;
      }
      body = await response.json();
    } catch (error) {
      this.reject(`${CONFIG_PATH} could not be read: ${error}`);
      return;
    }
    this.use(body);
  }

  /** Takes the address from a parsed configuration. Outside development, only `wss://` is valid. */
  public use(body: unknown): void {
    const url = (body as { websocketUrl?: unknown } | null)?.websocketUrl;
    const scheme = this.devMode ? /^wss?:\/\// : /^wss:\/\//;
    if (typeof url === 'string' && scheme.test(url)) {
      this.url.set(url);
      this.invalidSignal.set(false);
    } else {
      this.reject(`${CONFIG_PATH} has no valid websocketUrl.`);
    }
  }

  private reject(reason: string): void {
    if (this.devMode) {
      // Running on the fixed data is the expected way to work on the screens.
      console.info(`${reason} Using the fixed data.`);
    } else {
      console.error(`${reason} The client can't reach the backend.`);
      this.invalidSignal.set(true);
    }
  }
}
