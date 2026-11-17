import { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
 * Providers that make the client talk to fake sockets instead of the fixed data. Call
 * `useTestBackend()` after configuring TestBed to turn the backend address on.
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
