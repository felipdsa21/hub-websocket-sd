import { InjectionToken, Service, computed, inject, isDevMode, signal } from '@angular/core';

/** Where the configuration is served from; it stays out of Git, as the address isn't public. */
export const CONFIG_PATH = 'config.json';

/** Whether the app runs in development, where `ws://` is allowed. */
export const DEV_MODE = new InjectionToken<boolean>('DEV_MODE', { factory: () => isDevMode() });

/**
 * The backend address, read from `config.json` when the app starts. A missing or invalid
 * configuration makes entering fail (RNF07).
 */
@Service()
export class HubConfig {
  private readonly devMode = inject(DEV_MODE);
  private readonly url = signal<string | null>(null);

  public readonly websocketUrl = this.url.asReadonly();

  /** True without a valid address: entering fails. */
  public readonly invalid = computed(() => this.url() === null);

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
    } else {
      this.reject(`${CONFIG_PATH} has no valid websocketUrl.`);
    }
  }

  private reject(reason: string): void {
    console.error(`${reason} The client can't reach the backend.`);
    this.url.set(null);
  }
}
