import { Service, inject } from '@angular/core';
import { HubFixtures } from '@/core/fixtures/hub-fixtures';
import { UserState } from '@/core/model/user';
import { UsersStore } from './users-store';

/** Every user the backend knows, for searches (RF05); with the fixed data, the fixtures' list. */
@Service()
export class DirectoryStore {
  private readonly fixtures = inject(HubFixtures);
  private readonly users = inject(UsersStore);

  public get(username: string): UserState | undefined {
    return this.fixtures.data()?.directory.find((u) => u.username === username);
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
}
