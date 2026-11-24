import { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionStore } from '@/core/state/session-store';
import { provideTestClock } from '@/core/time/testing';
import { HubConfig } from './hub-config';
import { WEB_SOCKET_FACTORY } from './hub-socket';

export const TEST_WEBSOCKET_URL = 'wss://hub.example/dev';

/** A WebSocket the test drives: it records what the client sends and plays the server's part. */
export class FakeWebSocket {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public readonly sent: Record<string, unknown>[] = [];
  public closed = false;

  constructor(public readonly url: string) {}

  public send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  public close(): void {
    this.closed = true;
  }

  public open(): void {
    this.onopen?.(new Event('open'));
  }

  public receive(event: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  }

  /** The server or the network closes the connection. */
  public drop(): void {
    this.closed = true;
    this.onclose?.(new CloseEvent('close'));
  }

  /** The last request sent, to answer it by its `requestId`. */
  public last(): Record<string, unknown> & { requestId: string } {
    return this.sent.at(-1) as Record<string, unknown> & { requestId: string };
  }
}

/**
 * Providers that make the client talk to fake sockets. Call `useTestBackend()` after configuring
 * TestBed to turn the backend address on.
 */
export function provideFakeSockets(sockets: FakeWebSocket[]): Provider[] {
  return [
    {
      provide: WEB_SOCKET_FACTORY,
      useValue: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    },
  ];
}

export function useTestBackend(): void {
  TestBed.inject(HubConfig).use({ websocketUrl: TEST_WEBSOCKET_URL });
}

export const ALICE = { username: 'alice', displayName: 'Alice', online: true, version: 3 };
export const BRUNO = { username: 'bruno', displayName: 'Bruno', online: true, version: 7 };
export const CARLA = { username: 'carla', displayName: 'Carla', online: false, version: 2 };
export const ALICE_BRUNO = 'd:alice:bruno';
export const GROUP = {
  conversationId: 'g:1',
  type: 'group',
  name: 'SD',
  members: [ALICE, BRUNO],
  joinedAt: 500,
};

/** The direct chat between alice and bruno, as `sync` and `conversationAdded` send it. */
export function aliceBrunoChat(fields: Record<string, unknown> = {}) {
  return {
    conversationId: ALICE_BRUNO,
    type: 'direct',
    members: [ALICE, BRUNO],
    joinedAt: 100,
    ...fields,
  };
}

/** Answers the last request the client sent with `data`. */
export function answer(socket: FakeWebSocket, data: unknown): void {
  socket.receive({ type: 'response', requestId: socket.last().requestId, data });
}

/** Refuses the last request the client sent with the error `code`. */
export function refuse(socket: FakeWebSocket, code: string, details?: unknown): void {
  socket.receive({
    type: 'error',
    requestId: socket.last().requestId,
    code,
    message: code,
    ...(details !== undefined && { details }),
  });
}

/**
 * Enters as alice against a fake backend whose `sync` lists the given conversations, and returns
 * the open socket.
 */
export async function enterAsAlice(
  enter: (username: string, displayName: string) => Promise<void>,
  sockets: FakeWebSocket[],
  conversations: unknown[] = [aliceBrunoChat()],
): Promise<FakeWebSocket> {
  const entering = enter('alice', 'Alice');
  const socket = sockets.at(-1)!;
  socket.open();
  await Promise.resolve();
  answer(socket, { serverTime: 1000, updated: [], conversations });
  await entering;
  return socket;
}

/**
 * Configures TestBed with the test clock and fake sockets, then enters as alice with `sync` listing
 * the given conversations, and returns the open socket.
 */
export async function enterTestSession(conversations?: unknown[]): Promise<FakeWebSocket> {
  localStorage.clear();
  const sockets: FakeWebSocket[] = [];
  TestBed.configureTestingModule({
    providers: [...provideTestClock(), ...provideFakeSockets(sockets)],
  });
  useTestBackend();
  const session = TestBed.inject(SessionStore);
  return enterAsAlice((u, d) => session.enter(u, d), sockets, conversations);
}
