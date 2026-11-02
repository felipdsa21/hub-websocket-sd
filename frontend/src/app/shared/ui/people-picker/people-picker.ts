import { Component, computed, inject, input, model, output, signal } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatChip, MatChipRemove, MatChipSet } from '@angular/material/chips';
import { MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { Presence, UserState } from '@/core/model/user';
import { ConnectionStore } from '@/core/state/connection-store';
import { DirectoryStore } from '@/core/state/directory-store';
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
    MatChip,
    MatChipRemove,
    MatChipSet,
    MatFormField,
    MatIcon,
    MatIconButton,
    MatInput,
    MatLabel,
    MatSuffix,
    ResultRow,
  ],
  templateUrl: './people-picker.html',
  styleUrl: './people-picker.scss',
})
export class PeoplePicker {
  private readonly directory = inject(DirectoryStore);
  protected readonly connected = inject(ConnectionStore).connected;

  public readonly label = input('Pessoa');
  public readonly multiple = input(false);
  /** Usernames left out of the results, such as the user and a group's members. */
  public readonly exclude = input<ReadonlySet<string>>(new Set());
  public readonly selected = model<readonly UserState[]>([]);
  public readonly picked = output<UserState>();

  protected readonly query = signal('');
  protected readonly results = computed(() =>
    this.directory.searchPeople(this.query(), this.exclude()),
  );

  /** Names shared by several people in sight show the username too (specification, section 2). */
  private readonly repeated = computed(() =>
    repeatedDisplayNames([...this.results(), ...this.selected()]),
  );

  /** Chips carry the username next to a repeated name; results carry it in the subtitle. */
  protected nameOf(user: UserState): string {
    return nameWithUsername(user, this.repeated());
  }

  protected presenceOf(user: UserState): Presence | null {
    return presenceOf(user, this.connected());
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

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
