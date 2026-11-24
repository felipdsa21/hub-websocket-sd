import { TestBed } from '@angular/core/testing';
import { HubSocket } from '@/core/hub/hub-socket';
import { FakeWebSocket, provideFakeSockets, useTestBackend } from '@/core/hub/testing';
import { provideTestClock } from '@/core/time/testing';
import { ConnectionStore } from './connection-store';

describe('ConnectionStore', () => {
  it('follows the WebSocket connection', async () => {
    const sockets: FakeWebSocket[] = [];
    TestBed.configureTestingModule({
      providers: [...provideTestClock(), ...provideFakeSockets(sockets)],
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
