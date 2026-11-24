import { DOCUMENT, DestroyRef, Service, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HubConfig } from '@/core/hub/hub-config';
import { HubEvents } from '@/core/hub/hub-events';
import { HubSocket, RequestFailure } from '@/core/hub/hub-socket';
import { SyncData, toConversation } from '@/core/hub/protocol';
import { isValidDisplayName, normalizeDisplayName, normalizeUsername } from '@/core/model/names';
import { UserState } from '@/core/model/user';
import { ConnectionStore } from './connection-store';
import { ConversationsStore } from './conversations-store';
import { CurrentUser, SessionUser } from './current-user';
import { MessagesStore, SYNC_OVERLAP_MS } from './messages-store';
import { TelemetryStore } from './telemetry-store';
import { CURRENT_USER_STORAGE_KEY, UserStorage, userStorageKey } from './user-storage';
import { UsersStore } from './users-store';

export type EnterStatus = 'idle' | 'connecting' | 'failed';

/** First retry is immediate (0 ms); then exponential backoff up to 30 s (RF08, section 4.4). */
export const RECONNECT_INITIAL_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

@Service()
export class SessionStore {
  private readonly currentUser = inject(CurrentUser);
  private readonly users = inject(UsersStore);
  private readonly conversations = inject(ConversationsStore);
  private readonly messages = inject(MessagesStore);
  private readonly config = inject(HubConfig);
  private readonly socket = inject(HubSocket);
  private readonly connection = inject(ConnectionStore);
  private readonly storage = inject(UserStorage);
  private readonly events = inject(HubEvents);
  private readonly telemetry = inject(TelemetryStore);
  private readonly router = inject(Router, { optional: true });
  private readonly window = inject(DOCUMENT).defaultView;

  public readonly user = this.currentUser.user.asReadonly();
  public readonly enterStatus = signal<EnterStatus>('idle');

  /** The display name sent on connect and on every reconnection; empty sends none (RF01). */
  private activeDisplayName = '';
  /** `serverTime` from the last successful `sync`, used to compute `since` (section 4.4). */
  private lastSyncServerTime?: number;
  /** Incremented on enter/leave/destroy to cancel any running reconnection loop. */
  private sessionGeneration = 0;
  private reconnecting = false;
  private cancelReconnectWait?: () => void;
  private wakeReconnectWait?: () => void;

  constructor() {
    const destroyRef = inject(DestroyRef);
    const subscription = this.socket.dropped.subscribe(() => {
      if (this.currentUser.user()) {
        this.startReconnect();
      }
    });
    destroyRef.onDestroy(() => {
      subscription.unsubscribe();
      this.cancelReconnect();
    });

    const win = this.window;
    if (win) {
      const onStorage = (event: StorageEvent) => this.handleStorage(event);
      const onOffline = () => this.handleOffline();
      const onOnline = () => this.handleOnline();
      win.addEventListener('storage', onStorage);
      win.addEventListener('offline', onOffline);
      win.addEventListener('online', onOnline);
      destroyRef.onDestroy(() => {
        win.removeEventListener('storage', onStorage);
        win.removeEventListener('offline', onOffline);
        win.removeEventListener('online', onOnline);
      });
    }
  }

  /**
   * Enters from the entry screen. Without a display name, the username is used (RF01). It opens the
   * connection and loads the conversation list with `sync`; a failure is shown as a failure to
   * enter, without reconnecting (architecture, section 4.6).
   */
  public async enter(username: string, displayName: string): Promise<void> {
    const name = normalizeDisplayName(displayName);
    const user: SessionUser = {
      username: normalizeUsername(username),
      displayName: name || normalizeUsername(username),
    };
    if (this.config.invalid()) {
      this.enterStatus.set('failed');
    } else {
      await this.enterLive(user, name);
    }
  }

  /**
   * Restores the browser's persisted session on reload or in a new tab (RF01, section 4.6).
   * Connection failures during restoration are treated as drops with exponential reconnect (RF08).
   */
  public restore(): boolean {
    if (this.config.invalid() || this.currentUser.user()) {
      return false;
    }
    const username = this.storage.readCurrentUser();
    if (!username) {
      return false;
    }
    const savedDisplayName = this.storage.readDisplayName(username) ?? '';
    this.enterStored(username, savedDisplayName);
    return true;
  }

  /**
   * Changes the display name (RF01, section 4.6). Opens a parallel WebSocket with the new name and drains the previous one without going offline; if opening fails, keeps
   * the current connection active and returns `false`.
   */
  public async changeDisplayName(displayName: string): Promise<boolean> {
    const user = this.currentUser.user();
    if (!user || !isValidDisplayName(displayName)) {
      return false;
    }
    const name = normalizeDisplayName(displayName);
    if (!this.connection.connected()) {
      return false;
    }
    const generation = this.sessionGeneration;
    try {
      await this.socket.reconnectInParallel(user.username, name);
      if (generation !== this.sessionGeneration) {
        return false;
      }
      this.activeDisplayName = name;
      this.storage.writeDisplayName(user.username, name);
      this.currentUser.user.set({ ...user, displayName: name });
      // Do not increment `version` locally so server `presence` announcements still apply.
      this.users.setDisplayName(user.username, name);
      return true;
    } catch (error) {
      console.warn('Failed to change display name:', error);
      return false;
    }
  }

  public leave(): void {
    this.storage.clearCurrentUser();
    this.resetSessionState();
  }

  private resetSessionState(): void {
    this.cancelReconnect();
    this.connection.reset();
    this.events.stop();
    this.socket.close();
    this.activeDisplayName = '';
    this.lastSyncServerTime = undefined;
    this.users.reset([]);
    this.conversations.reset([], new Map());
    this.conversations.loading.set(false);
    this.messages.reset();
    this.telemetry.reset();
    this.currentUser.user.set(null);
    this.enterStatus.set('idle');
  }

  private async enterLive(user: SessionUser, displayName: string): Promise<void> {
    this.cancelReconnect();
    const generation = this.sessionGeneration;
    this.connection.reset();
    this.telemetry.clear();
    this.enterStatus.set('connecting');
    // Listening starts before `sync`: an event that arrives before its answer is held and applied
    // after the lists are loaded, so it isn't lost.
    this.events.start();
    try {
      await this.socket.connect(user.username, displayName || undefined);
      if (generation !== this.sessionGeneration) {
        return;
      }
      // Persist the browser's active user and display name only after the first connection opens.
      this.storage.writeCurrentUser(user.username);
      if (displayName) {
        this.storage.writeDisplayName(user.username, displayName);
      } else {
        this.storage.clearDisplayName(user.username);
      }
      const data = await this.socket.request<SyncData>('sync');
      if (generation !== this.sessionGeneration) {
        return;
      }
      this.activeDisplayName = displayName;
      this.lastSyncServerTime = data.serverTime;
      this.loadSynced(user, data);
      this.events.release();
    } catch (error) {
      if (generation !== this.sessionGeneration) {
        return;
      }
      console.warn('Failed to enter:', error);
      this.events.stop();
      this.socket.close();
      this.enterStatus.set('failed');
    }
  }

  /**
   * Enters straight into the session using a stored user (reload, new tab or cross-tab switch),
   * treating connection errors as network drops with automatic reconnection (RF01, RF08).
   */
  private enterStored(username: string, displayName: string): void {
    this.resetSessionState();
    const user: SessionUser = { username, displayName: displayName || username };
    this.activeDisplayName = displayName;
    this.users.reset([{ ...user, online: true, version: 0 }]);
    this.conversations.reset([], this.storage.readSeen(username));
    this.conversations.loading.set(true);
    this.currentUser.user.set(user);
    this.startReconnect();
  }

  private handleStorage(event: StorageEvent): void {
    if (event.storageArea && event.storageArea !== this.localStorageOrNull()) {
      return;
    }
    const current = this.currentUser.user();
    if (event.key === CURRENT_USER_STORAGE_KEY || event.key === null) {
      const storedUser = this.storage.readCurrentUser();
      if (!storedUser) {
        if (current || this.enterStatus() === 'connecting') {
          this.resetSessionState();
          void this.router?.navigateByUrl('/entrar');
        }
        return;
      }
      if (storedUser !== current?.username) {
        const savedDisplayName = this.storage.readDisplayName(storedUser) ?? '';
        this.enterStored(storedUser, savedDisplayName);
        void this.router?.navigateByUrl('/');
        return;
      }
    }
    if (current && (event.key === userStorageKey(current.username) || event.key === null)) {
      this.conversations.mergeSeen(this.storage.readSeen(current.username));
      const savedDisplayName = this.storage.readDisplayName(current.username) ?? '';
      this.activeDisplayName = savedDisplayName;
      const effectiveName = savedDisplayName || current.username;
      if (current.displayName !== effectiveName) {
        this.currentUser.user.set({ ...current, displayName: effectiveName });
        this.users.setDisplayName(current.username, effectiveName);
      }
    }
  }

  private handleOffline(): void {
    if (this.currentUser.user()) {
      this.socket.checkConnection();
    }
  }

  private handleOnline(): void {
    if (!this.currentUser.user()) {
      return;
    }
    if (this.wakeReconnectWait) {
      this.wakeReconnectWait();
    } else if (!this.reconnecting && this.socket.status() === 'lost') {
      this.startReconnect();
    }
  }

  private localStorageOrNull(): Storage | null {
    try {
      return this.window?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private startReconnect(): void {
    if (this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    this.connection.markLost();
    void this.reconnectLoop(this.sessionGeneration);
  }

  private cancelReconnect(): void {
    this.sessionGeneration++;
    this.reconnecting = false;
    this.cancelReconnectWait?.();
    this.cancelReconnectWait = undefined;
    this.wakeReconnectWait = undefined;
  }

  private async reconnectLoop(generation: number): Promise<void> {
    let attempt = 0;
    try {
      while (generation === this.sessionGeneration && this.currentUser.user()) {
        const delayMs =
          attempt === 0
            ? 0
            : Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
        attempt++;
        // Client log used in the tests (architecture, section 4.6, T7).
        console.info(`Reconnecting (attempt ${attempt}, delay ${delayMs} ms).`);
        this.telemetry.record(
          'connection',
          `Tentativa de reconexão #${attempt} (espera ${delayMs} ms)`,
        );
        if (delayMs > 0) {
          const outcome = await this.waitDelay(delayMs, generation);
          if (outcome === 'cancelled') {
            return;
          }
          if (outcome === 'woken') {
            attempt = 0;
          }
        }
        const user = this.currentUser.user();
        if (!user || generation !== this.sessionGeneration) {
          return;
        }
        this.events.start();
        try {
          await this.socket.connect(user.username, this.activeDisplayName || undefined);
          if (generation !== this.sessionGeneration) {
            return;
          }
          const data = await this.syncWithRetry();
          if (generation !== this.sessionGeneration) {
            return;
          }
          this.applyReconnectedSync(data);
          // Start catch-up before releasing held events so a held message doesn't advance `after`.
          this.messages.syncAfterReconnect(data.updated);
          this.events.release();
          this.connection.markRecovered();
          this.telemetry.record('connection', 'Conexão restabelecida após sincronização');
          this.messages.resendPending();
          return;
        } catch (error) {
          if (generation !== this.sessionGeneration) {
            return;
          }
          console.warn('Reconnect attempt failed:', error);
          this.events.stop();
          this.socket.close();
        }
      }
    } finally {
      if (generation === this.sessionGeneration) {
        this.reconnecting = false;
      }
    }
  }

  /**
   * Sends `sync` with `since` shifted back 30 s. If it gets no answer in 15 s while the socket is
   * still open, retries once before letting the loop reconnect (architecture, section 4.6).
   */
  private async syncWithRetry(): Promise<SyncData> {
    const since = this.nextSyncSince();
    const fields = since === undefined ? {} : { since };
    try {
      return await this.socket.request<SyncData>('sync', fields);
    } catch (error) {
      if (
        error instanceof RequestFailure &&
        error.reason === 'noResponse' &&
        this.socket.status() === 'open'
      ) {
        return await this.socket.request<SyncData>('sync', fields);
      }
      throw error;
    }
  }

  private nextSyncSince(): number | undefined {
    const base = Math.max(this.lastSyncServerTime ?? 0, this.messages.lastReceivedSentAt() ?? 0);
    return base > 0 ? Math.max(0, base - SYNC_OVERLAP_MS) : undefined;
  }

  private applyReconnectedSync(data: SyncData): void {
    this.lastSyncServerTime = Math.max(this.lastSyncServerTime ?? 0, data.serverTime);
    for (const member of data.conversations.flatMap((c) => c.members)) {
      this.users.apply(member);
    }
    this.conversations.sync(data.conversations.map(toConversation));
    this.conversations.loading.set(false);
  }

  private waitDelay(
    delayMs: number,
    generation: number,
  ): Promise<'elapsed' | 'woken' | 'cancelled'> {
    return new Promise((resolve) => {
      const clear = () => {
        clearTimeout(timer);
        this.cancelReconnectWait = undefined;
        this.wakeReconnectWait = undefined;
      };
      const timer = setTimeout(() => {
        clear();
        resolve(generation === this.sessionGeneration ? 'elapsed' : 'cancelled');
      }, delayMs);
      this.cancelReconnectWait = () => {
        clear();
        resolve('cancelled');
      };
      this.wakeReconnectWait = () => {
        clear();
        resolve(generation === this.sessionGeneration ? 'woken' : 'cancelled');
      };
    });
  }

  /** Takes the conversation list and the members' states from the answer of `sync` (4.5). */
  private loadSynced(user: SessionUser, data: SyncData): void {
    const states = new Map<string, UserState>();
    for (const member of data.conversations.flatMap((c) => c.members)) {
      const known = states.get(member.username);
      if (!known || known.version < member.version) {
        states.set(member.username, member);
      }
    }
    this.users.reset([...states.values()]);
    // Without any conversation, the user's own state isn't in the answer; version 0 yields to any.
    this.users.apply({ ...user, online: true, version: 0 });
    this.conversations.reset(
      data.conversations.map(toConversation),
      this.storage.readSeen(user.username),
    );
    this.conversations.loading.set(false);
    this.messages.reset();
    this.currentUser.user.set(user);
    this.enterStatus.set('idle');
  }
}
