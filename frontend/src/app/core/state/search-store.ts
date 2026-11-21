import { Service, inject, signal } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';
import { HubConfig } from '@/core/hub/hub-config';
import { HubSocket } from '@/core/hub/hub-socket';
import { SearchData, toConversation } from '@/core/hub/protocol';
import { Conversation } from '@/core/model/conversation';
import { UserState } from '@/core/model/user';
import { ConversationsStore } from './conversations-store';
import { CurrentUser } from './current-user';
import { DirectoryStore, SEARCH_DELAY_MS } from './directory-store';
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
  private readonly config = inject(HubConfig);
  private readonly socket = inject(HubSocket);

  public readonly status = signal<SearchStatus>('idle');
  public readonly results = signal<SearchResults>(EMPTY);
  private lastQuery = '';
  /** Counts the searches, so the answer of an older one doesn't replace a newer one. */
  private searchCount = 0;
  private timer?: ReturnType<typeof setTimeout>;

  public search(query: string): void {
    this.lastQuery = query;
    const count = ++this.searchCount;
    clearTimeout(this.timer);
    const needle = query.trim().toLocaleLowerCase('pt-BR');
    if (!needle) {
      this.status.set('idle');
      this.results.set(EMPTY);
      return;
    }
    if (this.config.live()) {
      this.status.set('loading');
      this.timer = setTimeout(() => void this.searchLive(query.trim(), count), SEARCH_DELAY_MS);
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

  /**
   * Searches on the backend. The conversations found are shown as the client keeps them, in the
   * order of the list (architecture, section 4.6).
   */
  private async searchLive(query: string, count: number): Promise<void> {
    try {
      const data = await this.socket.request<SearchData>('search', { query });
      if (count !== this.searchCount) {
        return;
      }
      for (const conversation of data.conversations) {
        conversation.members.forEach((member) => this.users.apply(member));
      }
      this.directory.remember(data.people);
      const ids = new Set(data.conversations.map((c) => c.conversationId));
      const known = this.conversations.sorted().filter((c) => ids.has(c.conversationId));
      const unknown = data.conversations
        .filter((c) => !this.conversations.get(c.conversationId))
        .map(toConversation);
      this.results.set({ conversations: [...known, ...unknown], people: data.people });
      this.status.set('done');
    } catch {
      if (count === this.searchCount) {
        this.status.set('error');
      }
    }
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
