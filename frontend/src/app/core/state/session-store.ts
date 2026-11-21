import { DestroyRef, Service, inject, signal } from '@angular/core';
import { Fixtures, createFixtures } from '@/core/fixtures/fixtures';
import { HubFixtures } from '@/core/fixtures/hub-fixtures';
import { Scenarios } from '@/core/fixtures/scenarios';
import { HubConfig } from '@/core/hub/hub-config';
import { HubEvents } from '@/core/hub/hub-events';
import { HubSocket, RequestFailure } from '@/core/hub/hub-socket';
import { SyncData, toConversation } from '@/core/hub/protocol';
import { normalizeDisplayName, normalizeUsername } from '@/core/model/names';
import { UserState } from '@/core/model/user';
import { Clock } from '@/core/time/clock';
import { ConnectionStore } from './connection-store';
import { ConversationsStore } from './conversations-store';
import { CurrentUser, SessionUser } from './current-user';
import { MessagesStore, SYNC_OVERLAP_MS } from './messages-store';
import { UserStorage } from './user-storage';
import { UsersStore } from './users-store';

export type EnterStatus = 'idle' | 'connecting' | 'failed';

/** First retry is immediate (0 ms); then exponential backoff up to 30 s (RF08, section 4.4). */
export const RECONNECT_INITIAL_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

@Service()
export class SessionStore {
  private readonly currentUser = inject(CurrentUser);
  private readonly fixtures = inject(HubFixtures);
  private readonly users = inject(UsersStore);
  private readonly conversations = inject(ConversationsStore);
  private readonly messages = inject(MessagesStore);
  private readonly scenarios = inject(Scenarios);
  private readonly clock = inject(Clock);
  private readonly config = inject(HubConfig);
  private readonly socket = inject(HubSocket);
  private readonly connection = inject(ConnectionStore);
  private readonly storage = inject(UserStorage);
  private readonly events = inject(HubEvents);

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

  constructor() {
    const subscription = this.socket.dropped.subscribe(() => {
      if (this.config.live() && this.currentUser.user()) {
        this.startReconnect();
      }
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      this.cancelReconnect();
    });
  }

  /**
   * Enters from the entry screen. Without a display name, the username is used (RF01). With the
   * backend, it opens the connection and loads the conversation list with `sync`; a failure is shown
   * as a failure to enter, without reconnecting (architecture, section 4.6).
   */
  public async enter(username: string, displayName: string): Promise<void> {
    const name = normalizeDisplayName(displayName);
    const user: SessionUser = {
      username: normalizeUsername(username),
      displayName: name || normalizeUsername(username),
    };
    if (this.config.invalid()) {
      this.enterStatus.set('failed');
    } else if (this.config.live()) {
      await this.enterLive(user, name);
    } else if (this.scenarios.has('entrar-falha')) {
      this.enterStatus.set('failed');
    } else if (this.scenarios.has('carregando')) {
      this.enterStatus.set('connecting');
    } else {
      this.load(user);
    }
  }

  /** Enters as Marina, the user of the fixed data, so a scenario URL opens straight on it. */
  public enterForScenario(): void {
    this.load({ username: 'marina', displayName: 'Marina Alves' });
  }

  /**
   * Changes the display name. The client reconnects with it, without going offline (RF01); with
   * the fixed data, the user's own state just takes the new name, with a newer version.
   */
  public changeDisplayName(displayName: string): void {
    const user = this.currentUser.user();
    if (!user) {
      return;
    }
    const name = normalizeDisplayName(displayName);
    this.activeDisplayName = name;
    this.currentUser.user.set({ ...user, displayName: name });
    const state = this.users.get(user.username);
    this.users.apply({
      username: user.username,
      displayName: name,
      online: true,
      version: (state?.version ?? 0) + 1,
    });
  }

  public leave(): void {
    this.cancelReconnect();
    this.connection.reset();
    this.events.stop();
    this.socket.close();
    this.activeDisplayName = '';
    this.lastSyncServerTime = undefined;
    this.fixtures.data.set(null);
    this.users.reset([]);
    this.conversations.reset([], new Map());
    this.messages.reset(null);
    this.currentUser.user.set(null);
    this.enterStatus.set('idle');
  }

  private async enterLive(user: SessionUser, displayName: string): Promise<void> {
    this.cancelReconnect();
    this.connection.reset();
    this.enterStatus.set('connecting');
    // Listening starts before `sync`: an event that arrives before its answer is held and applied
    // after the lists are loaded, so it isn't lost.
    this.events.start();
    try {
      await this.socket.connect(user.username, displayName || undefined);
      const data = await this.socket.request<SyncData>('sync');
      this.activeDisplayName = displayName;
      this.lastSyncServerTime = data.serverTime;
      this.loadSynced(user, data);
      this.events.release();
    } catch (error) {
      console.warn('Failed to enter:', error);
      this.events.stop();
      this.socket.close();
      this.enterStatus.set('failed');
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
        if (delayMs > 0) {
          const ok = await this.waitDelay(delayMs, generation);
          if (!ok) {
            return;
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
  }

  private waitDelay(delayMs: number, generation: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancelReconnectWait = undefined;
        resolve(generation === this.sessionGeneration);
      }, delayMs);
      this.cancelReconnectWait = () => {
        clearTimeout(timer);
        resolve(false);
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
    this.fixtures.data.set(null);
    this.users.reset([...states.values()]);
    // Without any conversation, the user's own state isn't in the answer; version 0 yields to any.
    this.users.apply({ ...user, online: true, version: 0 });
    this.conversations.reset(
      data.conversations.map(toConversation),
      this.storage.readSeen(user.username),
    );
    this.conversations.loading.set(false);
    this.messages.reset(null);
    this.currentUser.user.set(user);
    this.enterStatus.set('idle');
  }

  private load(user: SessionUser): void {
    let data: Fixtures = createFixtures(user, this.clock.context());
    if (this.scenarios.has('sem-conversas')) {
      data = { ...data, conversations: [], messages: [], seen: new Map(), notices: [] };
    }
    const known = new Set([user.username, ...data.conversations.flatMap((c) => c.members)]);
    this.fixtures.data.set(data);
    this.users.reset(data.directory.filter((u) => known.has(u.username)));
    this.conversations.reset(data.conversations, data.seen);
    this.conversations.loading.set(this.scenarios.has('carregando'));
    this.messages.reset(data);
    this.currentUser.user.set(user);
    this.enterStatus.set('idle');
  }
}
