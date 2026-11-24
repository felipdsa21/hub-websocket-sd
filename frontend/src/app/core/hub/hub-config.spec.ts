import { TestBed } from '@angular/core/testing';
import { DEV_MODE, HubConfig } from './hub-config';

function setUp(devMode = true) {
  TestBed.configureTestingModule({ providers: [{ provide: DEV_MODE, useValue: devMode }] });
  const config = TestBed.inject(HubConfig);
  // Starts from a valid address, so each rejection has to clear it.
  config.use({ websocketUrl: 'wss://hub.example/ok' });
  expect(config.invalid()).toBe(false);
  return config;
}

function serve(body: unknown, ok = true): typeof fetch {
  return (() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) })) as unknown as typeof fetch;
}

describe('HubConfig', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('takes the address from config.json, accepting ws:// in development', async () => {
    const config = setUp();
    await config.load(serve({ websocketUrl: 'ws://localhost:3001' }));
    expect(config.websocketUrl()).toBe('ws://localhost:3001');
    expect(config.invalid()).toBe(false);
  });

  it('is invalid without config.json', async () => {
    const config = setUp();
    await config.load(serve(null, false));
    expect(config.invalid()).toBe(true);
    expect(console.error).toHaveBeenCalled();

    config.use({ websocketUrl: 'wss://hub.example/ok' });
    await config.load(() => Promise.reject(new Error('offline')));
    expect(config.invalid()).toBe(true);
  });

  it('is invalid with an address that is not a WebSocket URL', async () => {
    const config = setUp();
    await config.load(serve({ websocketUrl: 'https://hub.example/dev' }));
    expect(config.invalid()).toBe(true);
  });

  it('is invalid with a malformed WebSocket URL', async () => {
    const config = setUp();
    await config.load(serve({ websocketUrl: 'wss://' }));
    expect(config.invalid()).toBe(true);
  });

  it('is invalid with a config.json that is not JSON', async () => {
    const config = setUp();
    await config.load((() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.reject(new SyntaxError('bad')),
      })) as unknown as typeof fetch);
    expect(config.invalid()).toBe(true);
  });

  it('only accepts wss:// in a published build, as the page is served over HTTPS', async () => {
    const config = setUp(false);
    await config.load(serve({ websocketUrl: 'ws://hub.example/dev' }));
    expect(config.invalid()).toBe(true);

    await config.load(serve({ websocketUrl: 'wss://hub.example/dev' }));
    expect(config.invalid()).toBe(false);
  });
});
