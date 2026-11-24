import { Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatChip, MatChipRemove, MatChipSet } from '@angular/material/chips';
import { MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Presence, UserState } from '@/core/model/user';
import { ConnectionStore } from '@/core/state/connection-store';
import { DirectoryStore, SEARCH_DELAY_MS } from '@/core/state/directory-store';
import { SearchStatus } from '@/core/state/search-store';
import {
  joinParts,
  nameWithUsername,
  presenceOf,
  presenceText,
  repeatedDisplayNames,
} from '@/shared/format/display-names';
import { ResultRow } from '../result-row/result-row';

/**
 * Finds people by username or display name. With `multiple`, the chosen ones become chips and stay
 * marked in the results; otherwise, choosing one emits `picked`.
 */
@Component({
  selector: 'app-people-picker',
  imports: [
    MatButton,
    MatChip,
    MatChipRemove,
    MatChipSet,
    MatFormField,
    MatIcon,
    MatIconButton,
    MatInput,
    MatLabel,
    MatProgressSpinner,
    MatSuffix,
    ResultRow,
  ],
  templateUrl: './people-picker.html',
  styleUrl: './people-picker.scss',
})
export class PeoplePicker {
  private readonly directory = inject(DirectoryStore);
  private readonly connection = inject(ConnectionStore);
  protected readonly connected = this.connection.connected;
  private readonly presenceVisible = this.connection.presenceVisible;

  public readonly label = input('Pessoa');
  public readonly multiple = input(false);
  /** Usernames left out of the results, such as the user and a group's members. */
  public readonly exclude = input<ReadonlySet<string>>(new Set());
  public readonly selected = model<readonly UserState[]>([]);
  public readonly picked = output<UserState>();

  protected readonly query = signal('');
  /** The state of the search for the current query (RF09). */
  protected readonly status = signal<SearchStatus>('idle');
  /** The people of the current query; refreshed after a pause in typing. */
  private readonly found = signal<readonly UserState[]>([]);
  private readonly attempt = signal(0);
  protected readonly results = computed(() =>
    this.found().filter((u) => !this.exclude().has(u.username)),
  );
  protected readonly empty = computed(() => {
    if (!this.query().trim() || this.results().length > 0) {
      return false;
    }
    return this.status() === 'done';
  });

  constructor() {
    effect((onCleanup) => {
      const query = this.query();
      const connected = this.connected();
      this.attempt();
      if (!connected) {
        if (this.status() === 'loading') {
          this.status.set('idle');
        }
        return;
      }
      // The people of an older query can't be chosen while the new one waits for its answer.
      this.found.set([]);
      if (!query.trim()) {
        this.status.set('idle');
        return;
      }
      this.status.set('loading');
      let current = true;
      const timer = setTimeout(() => {
        this.directory.findPeople(query).then(
          (people) => {
            if (current) {
              this.found.set(people);
              this.status.set('done');
            }
          },
          () => current && this.status.set('error'),
        );
      }, SEARCH_DELAY_MS);
      onCleanup(() => {
        current = false;
        clearTimeout(timer);
      });
    });
  }

  /** Names shared by several people in sight show the username too (specification, section 2). */
  private readonly repeated = computed(() =>
    repeatedDisplayNames([...this.results(), ...this.selected()]),
  );

  /** Chips carry the username next to a repeated name; results carry it in the subtitle. */
  protected nameOf(user: UserState): string {
    return nameWithUsername(user, this.repeated());
  }

  protected presenceOf(user: UserState): Presence | null {
    return presenceOf(user, this.presenceVisible());
  }

  protected subtitleOf(user: UserState): string {
    return joinParts(
      this.repeated().has(user.displayName) && `@${user.username}`,
      presenceText(this.presenceOf(user)),
    );
  }

  protected isSelected(user: UserState): boolean {
    return this.selected().some((u) => u.username === user.username);
  }

  protected choose(user: UserState): void {
    if (!this.connected()) {
      return;
    }
    if (this.multiple()) {
      this.toggle(user);
    } else {
      this.picked.emit(user);
    }
  }

  protected toggle(user: UserState): void {
    this.selected.update((list) =>
      this.isSelected(user) ? list.filter((u) => u.username !== user.username) : [...list, user],
    );
  }

  protected retry(): void {
    if (this.connected()) {
      this.attempt.update((n) => n + 1);
    }
  }

  protected onQuery(event: Event): void {
    if (this.connected()) {
      this.query.set((event.target as HTMLInputElement).value);
    }
  }
}
