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

/** Events that answer a request, matched to it by the `requestId`. */
const REPLY_TYPES: ReadonlySet<string> = new Set(['response', 'pong', 'error']);

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
  readonly action: Action;
  readonly messageId?: string;
  readonly resolve: (data: unknown) => void;
  readonly reject: (failure: RequestFailure) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface SocketConnection {
  readonly socket: WebSocket;
  readonly username: string;
  readonly pending: Map<string, Pending>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  heartbeatInFlight: boolean;
  active: boolean;
}

interface PendingSwitch {
  readonly socket: WebSocket;
  readonly abort: (error: Error) => void;
}

/**
 * The WebSocket connection with the API Gateway (architecture, section 2). Requests carry a
 * `requestId`, and their answers are matched by it; the other events go to `events`. During a
 * display-name change, a second socket opens in parallel and the previous one drains until its
 * pending requests settle (section 4.6).
 */
@Service()
export class HubSocket {
  private readonly config = inject(HubConfig);
  private readonly createSocket = inject(WEB_SOCKET_FACTORY);

  private activeConn: SocketConnection | null = null;
  private readonly draining = new Set<SocketConnection>();
  /** Fails the `connect()` still waiting for the socket to open. */
  private abortConnect?: (error: Error) => void;
  private connectingSocket: WebSocket | null = null;
  /** Parallel connection opening for a display-name change while `activeConn` stays open. */
  private pendingSwitch: PendingSwitch | null = null;
  private readonly eventsSubject = new Subject<HubEvent>();
  private readonly droppedSubject = new Subject<void>();
  private readonly heartbeatRttSubject = new Subject<number>();

  public readonly status = signal<SocketStatus>('closed');
  public readonly events: Observable<HubEvent> = this.eventsSubject.asObservable();
  /** Fires immediately when an open connection closes unexpectedly or misses a heartbeat (RF08). */
  public readonly dropped: Observable<void> = this.droppedSubject.asObservable();
  /** Round-trip time (ms) of each answered heartbeat. */
  public readonly heartbeatRtt: Observable<number> = this.heartbeatRttSubject.asObservable();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.close());
  }

  /**
   * Opens a connection, closing the current one. Resolves when it opens; rejects if it closes first,
   * since the browser doesn't expose why a handshake was refused (architecture, section 4.6), or if
   * another `connect()` or a `close()` replaces it.
   */
  public connect(username: string, displayName?: string): Promise<void> {
    const url = this.buildUrl(username, displayName);
    if (!url) {
      return Promise.reject(new Error('No backend address configured.'));
    }
    this.close();
    const socket = this.createSocket(url);
    this.connectingSocket = socket;
    this.status.set('connecting');

    return new Promise((resolve, reject) => {
      this.abortConnect = reject;
      socket.onopen = () => {
        this.abortConnect = undefined;
        this.connectingSocket = null;
        const conn: SocketConnection = {
          socket,
          username,
          pending: new Map(),
          heartbeatInFlight: false,
          active: true,
        };
        this.activeConn = conn;
        this.attachOpenHandlers(conn);
        this.status.set('open');
        this.startHeartbeat(conn);
        resolve();
      };
      socket.onclose = () => {
        this.clearConnecting(new Error('The connection closed before opening.'));
        this.status.set('closed');
      };
    });
  }

  /**
   * Opens a second connection in parallel (RF01 display-name change). Once open, it becomes active
   * for new requests and the previous one closes as soon as its pending requests finish or time out,
   * without indicating a drop. If the new socket fails to open, the current one stays active.
   */
  public reconnectInParallel(username: string, displayName?: string): Promise<void> {
    const url = this.buildUrl(username, displayName);
    if (!url) {
      return Promise.reject(new Error('No backend address configured.'));
    }
    if (!this.activeConn || this.status() !== 'open') {
      return Promise.reject(new Error('No open connection to replace.'));
    }
    this.abortPendingSwitch();
    const socket = this.createSocket(url);

    return new Promise((resolve, reject) => {
      const switchEntry: PendingSwitch = { socket, abort: reject };
      this.pendingSwitch = switchEntry;
      socket.onopen = () => {
        if (this.pendingSwitch !== switchEntry) {
          socket.close();
          return;
        }
        this.pendingSwitch = null;
        const previous = this.activeConn;
        const next: SocketConnection = {
          socket,
          username,
          pending: new Map(),
          heartbeatInFlight: false,
          active: true,
        };
        this.activeConn = next;
        this.attachOpenHandlers(next);
        this.startHeartbeat(next);
        if (previous) {
          this.drainConnection(previous);
        }
        resolve();
      };
      socket.onclose = () => {
        if (this.pendingSwitch !== switchEntry) {
          return;
        }
        this.pendingSwitch = null;
        socket.onopen = socket.onmessage = socket.onclose = null;
        reject(new Error('The replacement connection closed before opening.'));
      };
    });
  }

  /** Triggers an immediate heartbeat probe on the active connection (e.g. on `window` `offline`). */
  public checkConnection(): void {
    const conn = this.activeConn;
    if (conn && this.status() === 'open') {
      this.sendHeartbeat(conn);
    }
  }

  /** Closes the connection on the user's request; it doesn't count as lost. */
  public close(): void {
    this.abortPendingSwitch();
    this.clearConnecting();
    if (this.activeConn) {
      const conn = this.activeConn;
      this.activeConn = null;
      this.detachConnection(conn);
      conn.socket.close();
    }
    this.closeDraining();
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
    const conn = this.activeConn;
    if (!conn || this.status() !== 'open') {
      return Promise.reject(new RequestFailure('noResponse'));
    }
    return this.requestOn(conn, action, fields, timeoutMs);
  }

  private buildUrl(username: string, displayName?: string): string | null {
    const base = this.config.websocketUrl();
    if (!base) {
      return null;
    }
    const url = new URL(base);
    url.searchParams.set('username', username);
    if (displayName) {
      url.searchParams.set('displayName', displayName);
    }
    return url.toString();
  }

  private attachOpenHandlers(conn: SocketConnection): void {
    conn.socket.onmessage = (event: MessageEvent) => this.receive(conn, event.data);
    conn.socket.onclose = () => this.onSocketClose(conn);
  }

  private onSocketClose(conn: SocketConnection): void {
    if (conn === this.activeConn) {
      this.handleActiveDrop(conn);
      return;
    }
    if (this.draining.delete(conn)) {
      this.detachConnection(conn);
    }
  }

  private handleActiveDrop(conn: SocketConnection): void {
    if (this.activeConn !== conn) {
      return;
    }
    this.activeConn = null;
    this.abortPendingSwitch();
    this.detachConnection(conn);
    conn.socket.close();
    this.closeDraining();
    this.status.set('lost');
    this.droppedSubject.next();
  }

  private drainConnection(conn: SocketConnection): void {
    conn.active = false;
    clearInterval(conn.heartbeatTimer);
    conn.heartbeatTimer = undefined;
    conn.heartbeatInFlight = false;
    // Pending heartbeats don't keep a replaced socket open.
    for (const [id, entry] of conn.pending) {
      if (entry.action === 'heartbeat') {
        clearTimeout(entry.timer);
        conn.pending.delete(id);
        entry.resolve(undefined);
      }
    }
    if (conn.pending.size === 0) {
      this.detachConnection(conn);
      conn.socket.close();
    } else {
      this.draining.add(conn);
    }
  }

  private closeIfDrained(conn: SocketConnection): void {
    if (!conn.active && conn.pending.size === 0 && this.draining.delete(conn)) {
      this.detachConnection(conn);
      conn.socket.close();
    }
  }

  private requestOn<T = unknown>(
    conn: SocketConnection,
    action: Action,
    fields: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    const messageId =
      action === 'sendMessage' && typeof fields['messageId'] === 'string'
        ? fields['messageId']
        : undefined;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(requestId);
        reject(new RequestFailure('noResponse'));
        this.closeIfDrained(conn);
      }, timeoutMs);
      conn.pending.set(requestId, {
        action,
        messageId,
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
      try {
        conn.socket.send(JSON.stringify({ ...fields, action, requestId }));
      } catch {
        conn.pending.delete(requestId);
        clearTimeout(timer);
        reject(new RequestFailure('noResponse'));
        this.closeIfDrained(conn);
      }
    });
  }

  private receive(conn: SocketConnection, data: unknown): void {
    let event: {
      type?: unknown;
      requestId?: unknown;
      messageId?: unknown;
      sender?: unknown;
    } | null = null;
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
      typeof event.requestId === 'string' ? conn.pending.get(event.requestId) : undefined;
    if (pending && REPLY_TYPES.has(event.type)) {
      const reply = event as ReplyEvent;
      conn.pending.delete(reply.requestId!);
      clearTimeout(pending.timer);
      if (reply.type === 'error') {
        const { code, message, details } = reply;
        pending.reject(new RequestFailure({ code, message, ...(details && { details }) }));
      } else {
        pending.resolve(reply.type === 'response' ? reply.data : undefined);
      }
      this.closeIfDrained(conn);
      return;
    }
    if (event.type === 'error' && typeof event.messageId === 'string') {
      const reply = event as Extract<ReplyEvent, { type: 'error' }>;
      if (this.rejectPendingMessage(event.messageId, reply)) {
        return;
      }
      this.eventsSubject.next(event as HubEvent);
      return;
    }
    if (REPLY_TYPES.has(event.type)) {
      // The answer to a request that already timed out is ignored (architecture, section 4.6).
      return;
    }
    if (
      event.type === 'message' &&
      typeof event.messageId === 'string' &&
      typeof event.sender === 'string'
    ) {
      this.confirmPendingMessage(event.sender, event.messageId);
    }
    this.eventsSubject.next(event as HubEvent);
  }

  private confirmPendingMessage(sender: string, messageId: string): void {
    for (const conn of this.allConnections()) {
      if (conn.username !== sender) {
        continue;
      }
      for (const [requestId, entry] of conn.pending) {
        if (entry.messageId === messageId) {
          conn.pending.delete(requestId);
          clearTimeout(entry.timer);
          entry.resolve(undefined);
          this.closeIfDrained(conn);
        }
      }
    }
  }

  private rejectPendingMessage(
    messageId: string,
    reply: Extract<ReplyEvent, { type: 'error' }>,
  ): boolean {
    const { code, message, details } = reply;
    const failure = new RequestFailure({ code, message, ...(details && { details }) });
    let matched = false;
    for (const conn of this.allConnections()) {
      for (const [requestId, entry] of conn.pending) {
        if (entry.messageId === messageId) {
          conn.pending.delete(requestId);
          clearTimeout(entry.timer);
          entry.reject(failure);
          this.closeIfDrained(conn);
          matched = true;
        }
      }
    }
    return matched;
  }

  private allConnections(): SocketConnection[] {
    const connections: SocketConnection[] = [];
    if (this.activeConn) {
      connections.push(this.activeConn);
    }
    for (const conn of this.draining) {
      connections.push(conn);
    }
    return connections;
  }

  private startHeartbeat(conn: SocketConnection): void {
    conn.heartbeatTimer = setInterval(() => this.sendHeartbeat(conn), HEARTBEAT_INTERVAL_MS);
  }

  private sendHeartbeat(conn: SocketConnection): void {
    if (!conn.active || conn.heartbeatInFlight) {
      return;
    }
    conn.heartbeatInFlight = true;
    const startedAt = performance.now();
    this.requestOn(conn, 'heartbeat', {}, PONG_TIMEOUT_MS).then(
      () => {
        conn.heartbeatInFlight = false;
        if (conn.active) {
          this.heartbeatRttSubject.next(performance.now() - startedAt);
        }
      },
      () => {
        conn.heartbeatInFlight = false;
        // No `pong` in time: the connection is taken as lost (RF08).
        if (conn === this.activeConn && this.status() === 'open') {
          this.handleActiveDrop(conn);
        }
      },
    );
  }

  private clearConnecting(reason = new Error('The connection was replaced or closed.')): void {
    this.abortConnect?.(reason);
    this.abortConnect = undefined;
    if (this.connectingSocket) {
      const socket = this.connectingSocket;
      this.connectingSocket = null;
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
    }
  }

  private abortPendingSwitch(
    reason = new Error('The replacement connection was cancelled.'),
  ): void {
    const entry = this.pendingSwitch;
    if (!entry) {
      return;
    }
    this.pendingSwitch = null;
    entry.socket.onopen = entry.socket.onmessage = entry.socket.onclose = null;
    entry.socket.close();
    entry.abort(reason);
  }

  private closeDraining(): void {
    for (const conn of this.draining) {
      this.detachConnection(conn);
      conn.socket.close();
    }
    this.draining.clear();
  }

  /** Stops listening to the socket and fails the requests still waiting on it. */
  private detachConnection(conn: SocketConnection): void {
    conn.active = false;
    clearInterval(conn.heartbeatTimer);
    conn.heartbeatTimer = undefined;
    conn.heartbeatInFlight = false;
    conn.socket.onopen = conn.socket.onmessage = conn.socket.onclose = null;
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RequestFailure('noResponse'));
    }
    conn.pending.clear();
  }
}
