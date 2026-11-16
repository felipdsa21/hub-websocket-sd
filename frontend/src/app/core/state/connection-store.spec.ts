import { TestBed } from '@angular/core/testing';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { HubSocket } from '@/core/hub/hub-socket';
import { FakeWebSocket, provideFakeSockets, useTestBackend } from '@/core/hub/testing';
import { ConnectionStore } from './connection-store';

describe('ConnectionStore', () => {
  it('is connected with the fixed data, outside the "sem-conexao" scenario', () => {
    TestBed.configureTestingModule({ providers: provideTestFixtures() });
    expect(TestBed.inject(ConnectionStore).connected()).toBe(true);
  });

  it('is lost in the "sem-conexao" scenario', () => {
    TestBed.configureTestingModule({
      providers: provideTestFixtures({ scenarios: ['sem-conexao'] }),
    });
    expect(TestBed.inject(ConnectionStore).status()).toBe('lost');
  });

  it('follows the WebSocket connection with the backend', async () => {
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [...provideTestFixtures(), ...provideFakeSockets(sockets)],
    });
    useTestBackend();
    const connection = TestBed.inject(ConnectionStore);
    const opening = TestBed.inject(HubSocket).connect('alice');
    expect(connection.connected()).toBe(false);

    sockets[0]!.open();
    await opening;
    expect(connection.connected()).toBe(true);

    sockets[0]!.drop();
    expect(connection.status()).toBe('lost');
  });
});
