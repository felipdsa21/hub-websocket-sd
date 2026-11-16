import { DestroyRef, InjectionToken, Service, inject, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { ActionFailure } from '@/core/model/action-result';
import { HubConfig } from './hub-config';
import { Action, HubEvent, ReplyEvent } from './protocol';

/** The client sends `heartbeat` every 30 s and, without `pong` in 10 s, the connection is lost. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const PONG_TIMEOUT_MS = 10_000;
/** A request without an answer in 15 s may or may not have been done (RF09). */
export const REQUEST_TIMEOUT_MS = 15_000;

/** `lost`: the connection that was open closed without the client asking. */
export type SocketStatus = 'closed' | 'connecting' | 'open' | 'lost';

export const WEB_SOCKET_FACTORY = new InjectionToken<(url: string) => WebSocket>(
  'WEB_SOCKET_FACTORY',
  { factory: () => (url) => new WebSocket(url) },
);

/** A request that failed: refused with an `error` event, or without an answer (RF09). */
export class RequestFailure extends Error {
  constructor(public readonly reason: ActionFailure) {
    super(reason === 'noResponse' ? 'No response' : `${reason.code}: ${reason.message}`);
    this.name = 'RequestFailure';
  }
}

interface Pending {
  readonly resolve: (data: unknown) => void;
  readonly reject: (failure: RequestFailure) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The single WebSocket connection with the API Gateway (architecture, section 2). Requests carry a
 * `requestId`, and their answers are matched by it; the other events go to `events`.
 */
@Service()
export class HubSocket {
  private readonly config = inject(HubConfig);
  private readonly createSocket = inject(WEB_SOCKET_FACTORY);

  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly eventsSubject = new Subject<HubEvent>();

  public readonly status = signal<SocketStatus>('closed');
  public readonly events: Observable<HubEvent> = this.eventsSubject.asObservable();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.close());
  }

  /**
   * Opens a connection, closing the current one. Resolves when it opens; rejects if it closes first,
   * since the browser doesn't expose why a handshake was refused (architecture, section 4.6).
   */
  public connect(username: string, displayName?: string): Promise<void> {
    const base = this.config.websocketUrl();
    if (!base) {
      return Promise.reject(new Error('No backend address configured.'));
    }
    this.close();
    const url = new URL(base);
    url.searchParams.set('username', username);
    if (displayName) {
      url.searchParams.set('displayName', displayName);
    }
    const socket = this.createSocket(url.toString());
    this.socket = socket;
    this.status.set('connecting');

    return new Promise((resolve, reject) => {
      socket.onopen = () => {
        this.status.set('open');
        this.startHeartbeat();
        resolve();
      };
      socket.onmessage = (event: MessageEvent) => this.receive(event.data);
      socket.onclose = () => {
        const wasOpen = this.status() === 'open';
        this.detach();
        this.status.set(wasOpen ? 'lost' : 'closed');
        if (!wasOpen) {
          reject(new Error('The connection closed before opening.'));
        }
      };
    });
  }

  /** Closes the connection on the user's request; it doesn't count as lost. */
  public close(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.detach();
    socket.close();
    this.status.set('closed');
  }

  /**
   * Sends a request and resolves with the `data` of its `response`. Rejects with the `error` event
   * that refuses it, or with `noResponse` after the timeout or if the connection drops.
   */
  public request<T = unknown>(
    action: Action,
    fields: Readonly<Record<string, unknown>> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || this.status() !== 'open') {
      return Promise.reject(new RequestFailure('noResponse'));
    }
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RequestFailure('noResponse'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: (data) => resolve(data as T), reject, timer });
      socket.send(JSON.stringify({ ...fields, action, requestId }));
    });
  }

  private receive(data: unknown): void {
    let event: { type?: unknown; requestId?: unknown } | null = null;
    try {
      event = typeof data === 'string' ? JSON.parse(data) : null;
    } catch {
      // Logged below.
    }
    if (!event || typeof event.type !== 'string') {
      // An error from the API Gateway itself, without `type` nor `requestId` (section 4.2).
      console.warn('Unrecognized message from the server:', data);
      return;
    }
    const pending =
      typeof event.requestId === 'string' ? this.pending.get(event.requestId) : undefined;
    if (pending && ['response', 'pong', 'error'].includes(event.type)) {
      const reply = event as ReplyEvent;
      this.pending.delete(reply.requestId!);
      clearTimeout(pending.timer);
      if (reply.type === 'error') {
        const { code, message, details } = reply;
        pending.reject(new RequestFailure({ code, message, ...(details && { details }) }));
      } else {
        pending.resolve(reply.type === 'response' ? reply.data : undefined);
      }
      return;
    }
    if (['response', 'pong', 'error'].includes(event.type)) {
      // The answer to a request that already timed out is ignored (architecture, section 4.6).
      return;
    }
    this.eventsSubject.next(event as HubEvent);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.request('heartbeat', {}, PONG_TIMEOUT_MS).catch(() => {
        // No `pong` in time: the connection is taken as lost (RF08).
        if (this.status() === 'open') {
          this.socket?.close();
          this.detach();
          this.status.set('lost');
        }
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Stops listening to the socket and fails the requests still waiting. */
  private detach(): void {
    clearInterval(this.heartbeatTimer);
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onclose = null;
      this.socket = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RequestFailure('noResponse'));
    }
    this.pending.clear();
  }
}
