import { TestBed } from '@angular/core/testing';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { HubConfig } from './hub-config';

function setUp(scenarios: Parameters<typeof provideTestFixtures>[0] = {}) {
  TestBed.configureTestingModule({ providers: provideTestFixtures(scenarios) });
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

  it('stays on the fixed data without config.json', async () => {
    const config = setUp();
    await config.load(serve(null, false));
    await config.load(() => Promise.reject(new Error('offline')));
    expect(config.live()).toBe(false);
  });

  it('ignores an address that is not a WebSocket URL', async () => {
    const config = setUp();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await config.load(serve({ websocketUrl: 'https://hub.example/dev' }));
    expect(config.live()).toBe(false);
  });

  it('stays on the fixed data when a scenario is chosen', async () => {
    const config = setUp({ scenarios: ['pendentes'] });
    await config.load(serve({ websocketUrl: 'wss://hub.example/dev' }));
    expect(config.live()).toBe(false);
  });
});
