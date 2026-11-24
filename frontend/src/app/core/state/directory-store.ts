import { Service, inject, signal } from '@angular/core';
import { HubSocket } from '@/core/hub/hub-socket';
import { SearchData } from '@/core/hub/protocol';
import { UserState } from '@/core/model/user';
import { CurrentUser } from './current-user';

/** Pause in typing before a search goes to the backend, so not every key sends one. */
export const SEARCH_DELAY_MS = 250;

/** People found by `search`, so they can be named later (RF05). */
@Service()
export class DirectoryStore {
  private readonly socket = inject(HubSocket);
  private readonly currentUser = inject(CurrentUser);
  private readonly found = signal<ReadonlyMap<string, UserState>>(new Map());

  public get(username: string): UserState | undefined {
    return this.found().get(username);
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
}
