import { TestBed } from '@angular/core/testing';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { DEV_MODE, HubConfig } from './hub-config';

function setUp(scenarios: Parameters<typeof provideTestFixtures>[0] = {}, devMode = true) {
  TestBed.configureTestingModule({
    providers: [...provideTestFixtures(scenarios), { provide: DEV_MODE, useValue: devMode }],
  });
  return TestBed.inject(HubConfig);
}

function serve(body: unknown, ok = true): typeof fetch {
  return (() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) })) as unknown as typeof fetch;
}

describe('HubConfig', () => {
  it('goes live with the address from config.json', async () => {
    const config = setUp();
    await config.load(serve({ websocketUrl: 'wss://hub.example/dev' }));
    expect(config.websocketUrl()).toBe('wss://hub.example/dev');
    expect(config.live()).toBe(true);
  });

  it('stays on the fixed data without config.json in development', async () => {
    const config = setUp();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await config.load(serve(null, false));
    await config.load(() => Promise.reject(new Error('offline')));
    expect(config.live()).toBe(false);
    expect(config.invalid()).toBe(false);
  });

  it('ignores an address that is not a WebSocket URL', async () => {
    const config = setUp();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await config.load(serve({ websocketUrl: 'https://hub.example/dev' }));
    expect(config.live()).toBe(false);
  });

  it('stays on the fixed data when a scenario is chosen', async () => {
    const config = setUp({ scenarios: ['pendentes'] });
    await config.load(serve({ websocketUrl: 'wss://hub.example/dev' }));
    expect(config.live()).toBe(false);
  });

  describe('in a published build', () => {
    beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));

    it('is invalid without config.json, instead of using the fixed data', async () => {
      const config = setUp({}, false);
      await config.load(serve(null, false));
      expect(config.invalid()).toBe(true);
      expect(config.live()).toBe(false);
      expect(console.error).toHaveBeenCalled();
    });

    it('is invalid with a config.json that is not JSON', async () => {
      const config = setUp({}, false);
      await config.load((() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new SyntaxError('bad')),
        })) as unknown as typeof fetch);
      expect(config.invalid()).toBe(true);
    });

    it('only accepts wss://, as the page is served over HTTPS', async () => {
      const config = setUp({}, false);
      await config.load(serve({ websocketUrl: 'ws://hub.example/dev' }));
      expect(config.invalid()).toBe(true);

      await config.load(serve({ websocketUrl: 'wss://hub.example/dev' }));
      expect(config.invalid()).toBe(false);
      expect(config.live()).toBe(true);
    });
  });
});
