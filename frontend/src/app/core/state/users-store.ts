import { Service, signal } from '@angular/core';
import { UserState } from '@/core/model/user';

/** The latest known state of each user, from member lists and announcements. */
@Service()
export class UsersStore {
  private readonly states = signal<ReadonlyMap<string, UserState>>(new Map());

  public readonly all = this.states.asReadonly();

  public get(username: string): UserState | undefined {
    return this.states().get(username);
  }

  public reset(states: readonly UserState[]): void {
    this.states.set(new Map(states.map((state) => [state.username, state])));
  }

  /** Applies a state only if it is newer than the known one (architecture, section 3.5). */
  public apply(state: UserState): void {
    const known = this.states().get(state.username);
    if (known && known.version >= state.version) {
      return;
    }
    this.states.update((states) => new Map(states).set(state.username, state));
  }
}
