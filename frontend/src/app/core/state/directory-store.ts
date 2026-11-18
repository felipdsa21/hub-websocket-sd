import { Service, inject, signal } from '@angular/core';
import { HubFixtures } from '@/core/fixtures/hub-fixtures';
import { HubConfig } from '@/core/hub/hub-config';
import { HubSocket } from '@/core/hub/hub-socket';
import { SearchData } from '@/core/hub/protocol';
import { UserState } from '@/core/model/user';
import { CurrentUser } from './current-user';
import { UsersStore } from './users-store';

/** Pause in typing before a search goes to the backend, so not every key sends one. */
export const SEARCH_DELAY_MS = 250;

/**
 * Every user the backend knows, for searches (RF05). With the backend, they come from `search`;
 * with the fixed data, from the fixtures' list.
 */
@Service()
export class DirectoryStore {
  private readonly fixtures = inject(HubFixtures);
  private readonly users = inject(UsersStore);
  private readonly config = inject(HubConfig);
  private readonly socket = inject(HubSocket);
  private readonly currentUser = inject(CurrentUser);
  /** People found by searches on the backend, to name them later. */
  private readonly found = signal<ReadonlyMap<string, UserState>>(new Map());

  public get(username: string): UserState | undefined {
    return (
      this.fixtures.data()?.directory.find((u) => u.username === username) ??
      this.found().get(username)
    );
  }

  /** People who become contacts arrive with their states, as in the backend's member lists. */
  public makeKnown(usernames: readonly string[]): void {
    for (const username of usernames) {
      const state = this.get(username);
      if (state) {
        this.users.apply(state);
      }
    }
  }

  /** Records people found by a search on the backend. */
  public remember(states: readonly UserState[]): void {
    this.found.update((found) => {
      const next = new Map(found);
      for (const state of states) {
        const known = next.get(state.username);
        if (!known || known.version < state.version) {
          next.set(state.username, state);
        }
      }
      return next;
    });
  }

  /** Users whose username or display name contains the query, ignoring case (section 4.5). */
  public searchPeople(query: string, exclude: ReadonlySet<string> = new Set()): UserState[] {
    const needle = query.trim().toLocaleLowerCase('pt-BR');
    if (!needle) {
      return [];
    }
    return (this.fixtures.data()?.directory ?? []).filter(
      (u) =>
        !exclude.has(u.username) &&
        (u.username.includes(needle) || u.displayName.toLocaleLowerCase('pt-BR').includes(needle)),
    );
  }

  /**
   * Everyone the query finds on the backend, for choosing people. The backend lists someone with a
   * visible direct chat only as that chat, so those people are taken from the chats found.
   */
  public async findPeople(query: string): Promise<UserState[]> {
    const text = query.trim();
    if (!text) {
      return [];
    }
    const me = this.currentUser.user()?.username;
    const data = await this.socket.request<SearchData>('search', { query: text });
    const partners = data.conversations
      .filter((c) => c.type === 'direct')
      .flatMap((c) => c.members.filter((m) => m.username !== me));
    const people = [...partners, ...data.people].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, 'pt-BR'),
    );
    this.remember(people);
    return people;
  }

  /** True when people come from the backend instead of the fixed data. */
  public live(): boolean {
    return this.config.live();
  }
}
