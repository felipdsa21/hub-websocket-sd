import { Service, inject, signal } from '@angular/core';
import { Fixtures, createFixtures } from '@/core/fixtures/fixtures';
import { HubFixtures } from '@/core/fixtures/hub-fixtures';
import { Scenarios } from '@/core/fixtures/scenarios';
import { HubConfig } from '@/core/hub/hub-config';
import { HubEvents } from '@/core/hub/hub-events';
import { HubSocket } from '@/core/hub/hub-socket';
import { SyncData, toConversation } from '@/core/hub/protocol';
import { normalizeDisplayName, normalizeUsername } from '@/core/model/names';
import { UserState } from '@/core/model/user';
import { Clock } from '@/core/time/clock';
import { ConversationsStore } from './conversations-store';
import { CurrentUser, SessionUser } from './current-user';
import { MessagesStore } from './messages-store';
import { UserStorage } from './user-storage';
import { UsersStore } from './users-store';

export type EnterStatus = 'idle' | 'connecting' | 'failed';

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
  private readonly storage = inject(UserStorage);
  private readonly events = inject(HubEvents);

  public readonly user = this.currentUser.user.asReadonly();
  public readonly enterStatus = signal<EnterStatus>('idle');

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
    this.events.stop();
    this.socket.close();
    this.fixtures.data.set(null);
    this.users.reset([]);
    this.conversations.reset([], new Map());
    this.messages.reset(null);
    this.currentUser.user.set(null);
    this.enterStatus.set('idle');
  }

  private async enterLive(user: SessionUser, displayName: string): Promise<void> {
    this.enterStatus.set('connecting');
    // Listening starts before `sync`: an event that arrives before its answer is held and applied
    // after the lists are loaded, so it isn't lost.
    this.events.start();
    try {
      await this.socket.connect(user.username, displayName || undefined);
      const data = await this.socket.request<SyncData>('sync');
      this.loadSynced(user, data);
      this.events.release();
    } catch (error) {
      console.warn('Failed to enter:', error);
      this.events.stop();
      this.socket.close();
      this.enterStatus.set('failed');
    }
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
