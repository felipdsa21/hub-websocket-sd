import { Service, inject, signal } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';
import { Conversation } from '@/core/model/conversation';
import { UserState } from '@/core/model/user';
import { ConversationsStore } from './conversations-store';
import { CurrentUser } from './current-user';
import { DirectoryStore } from './directory-store';
import { UsersStore } from './users-store';

export type SearchStatus = 'idle' | 'loading' | 'error' | 'done';

export interface SearchResults {
  readonly conversations: readonly Conversation[];
  readonly people: readonly UserState[];
}

const EMPTY: SearchResults = { conversations: [], people: [] };

/**
 * Searches the user's conversations by name and the other users by username or display name
 * (RF05, architecture 4.5). Someone with a visible direct chat shows only as that conversation
 * (design note).
 */
@Service()
export class SearchStore {
  private readonly conversations = inject(ConversationsStore);
  private readonly users = inject(UsersStore);
  private readonly directory = inject(DirectoryStore);
  private readonly currentUser = inject(CurrentUser);
  private readonly scenarios = inject(Scenarios);

  public readonly status = signal<SearchStatus>('idle');
  public readonly results = signal<SearchResults>(EMPTY);
  private lastQuery = '';

  public search(query: string): void {
    this.lastQuery = query;
    const needle = query.trim().toLocaleLowerCase('pt-BR');
    if (!needle) {
      this.status.set('idle');
      this.results.set(EMPTY);
      return;
    }
    if (this.scenarios.has('carregando')) {
      this.status.set('loading');
      return;
    }
    if (this.scenarios.has('erro-pesquisa') || this.scenarios.has('sem-resposta')) {
      this.status.set('error');
      return;
    }
    this.results.set(this.find(needle));
    this.status.set('done');
  }

  public retry(): void {
    this.search(this.lastQuery);
  }

  public clear(): void {
    this.search('');
  }

  private find(needle: string): SearchResults {
    const me = this.currentUser.user()?.username ?? '';
    const matches = (text: string) => text.toLocaleLowerCase('pt-BR').includes(needle);
    const directPartners = new Map<string, Conversation>();
    const conversations = this.conversations.sorted().filter((c) => {
      if (c.type === 'group') {
        return matches(c.name ?? '');
      }
      const partner = c.members.find((m) => m !== me) ?? me;
      directPartners.set(partner, c);
      const state = this.users.get(partner);
      return matches(partner) || (state !== undefined && matches(state.displayName));
    });
    const people = this.directory
      .searchPeople(needle, new Set([me, ...directPartners.keys()]))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
    return { conversations, people };
  }
}
