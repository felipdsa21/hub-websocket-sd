import { Service, inject, signal } from '@angular/core';
import { Fixtures, createFixtures } from '@/core/fixtures/fixtures';
import { HubFixtures } from '@/core/fixtures/hub-fixtures';
import { Scenarios } from '@/core/fixtures/scenarios';
import { normalizeDisplayName, normalizeUsername } from '@/core/model/names';
import { Clock } from '@/core/time/clock';
import { ConversationsStore } from './conversations-store';
import { CurrentUser, SessionUser } from './current-user';
import { UsersStore } from './users-store';

export type EnterStatus = 'idle' | 'connecting' | 'failed';

@Service()
export class SessionStore {
  private readonly currentUser = inject(CurrentUser);
  private readonly fixtures = inject(HubFixtures);
  private readonly users = inject(UsersStore);
  private readonly conversations = inject(ConversationsStore);
  private readonly scenarios = inject(Scenarios);
  private readonly clock = inject(Clock);

  public readonly user = this.currentUser.user.asReadonly();
  public readonly enterStatus = signal<EnterStatus>('idle');

  /** Enters from the entry screen. Without a display name, the username is used (RF01). */
  public enter(username: string, displayName: string): void {
    const user: SessionUser = {
      username: normalizeUsername(username),
      displayName: normalizeDisplayName(displayName) || normalizeUsername(username),
    };
    if (this.scenarios.has('entrar-falha')) {
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

  public leave(): void {
    this.fixtures.data.set(null);
    this.users.reset([]);
    this.conversations.reset([], new Map());
    this.currentUser.user.set(null);
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
    this.currentUser.user.set(user);
    this.enterStatus.set('idle');
  }
}
