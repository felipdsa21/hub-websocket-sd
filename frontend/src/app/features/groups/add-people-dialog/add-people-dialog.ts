import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatChip, MatChipRemove, MatChipSet } from '@angular/material/chips';
import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { Breakpoints } from '@/core/layout/breakpoints';
import { UserState } from '@/core/model/user';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { DirectoryStore } from '@/core/state/directory-store';
import { repeatedDisplayNames } from '@/shared/format/display-names';
import { Avatar } from '@/shared/ui/avatar/avatar';

/** Closes with the chosen usernames, or nothing when cancelled. */
@Component({
  selector: 'app-add-people-dialog',
  imports: [
    Avatar,
    MatButton,
    MatChip,
    MatChipRemove,
    MatChipSet,
    MatDialogActions,
    MatDialogClose,
    MatDialogContent,
    MatDialogTitle,
    MatFormField,
    MatIcon,
    MatIconButton,
    MatInput,
    MatLabel,
    MatSuffix,
  ],
  templateUrl: './add-people-dialog.html',
  styleUrl: './add-people-dialog.scss',
  host: { '[class.compact]': 'compact()' },
})
export class AddPeopleDialog {
  private readonly dialogRef = inject(MatDialogRef<AddPeopleDialog, readonly string[]>);
  private readonly directory = inject(DirectoryStore);
  private readonly conversations = inject(ConversationsStore);
  private readonly breakpoints = inject(Breakpoints);

  protected readonly connected = inject(ConnectionStore).connected;

  public readonly conversationId = input.required<string>();

  protected readonly compact = computed(() => this.breakpoints.windowSize() === 'compact');
  protected readonly groupName = computed(
    () => this.conversations.get(this.conversationId())?.name ?? '',
  );

  protected readonly query = signal('');
  protected readonly selected = signal<readonly UserState[]>([]);

  protected readonly results = computed(() => {
    const members = new Set(this.conversations.get(this.conversationId())?.members ?? []);
    return this.directory.searchPeople(this.query(), members);
  });

  /** Names shared by several people in the results or the chips show the username too. */
  private readonly repeated = computed(() =>
    repeatedDisplayNames([...this.results(), ...this.selected()]),
  );

  protected label(user: UserState): string {
    return this.repeated().has(user.displayName)
      ? `${user.displayName} · @${user.username}`
      : user.displayName;
  }

  protected isSelected(user: UserState): boolean {
    return this.selected().some((u) => u.username === user.username);
  }

  protected toggle(user: UserState): void {
    this.selected.update((list) =>
      this.isSelected(user) ? list.filter((u) => u.username !== user.username) : [...list, user],
    );
  }

  protected remove(user: UserState): void {
    this.selected.update((list) => list.filter((u) => u.username !== user.username));
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected add(): void {
    if (this.selected().length > 0 && this.connected()) {
      this.dialogRef.close(this.selected().map((u) => u.username));
    }
  }
}
