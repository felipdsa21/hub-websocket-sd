import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButton } from '@angular/material/button';
import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogRef,
} from '@angular/material/dialog';
import { UserState } from '@/core/model/user';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { DialogHeader } from '@/shared/ui/dialog-header/dialog-header';
import { PeoplePicker } from '@/shared/ui/people-picker/people-picker';

/** Closes with the chosen usernames, or nothing when cancelled. */
@Component({
  selector: 'app-add-people-dialog',
  imports: [
    DialogHeader,
    MatButton,
    MatDialogActions,
    MatDialogClose,
    MatDialogContent,
    PeoplePicker,
  ],
  templateUrl: './add-people-dialog.html',
})
export class AddPeopleDialog {
  private readonly dialogRef = inject(MatDialogRef<AddPeopleDialog, readonly string[]>);
  private readonly conversations = inject(ConversationsStore);
  private readonly connected = inject(ConnectionStore).connected;

  public readonly conversationId = input.required<string>();

  protected readonly groupName = computed(
    () => this.conversations.get(this.conversationId())?.name ?? '',
  );
  protected readonly members = computed(
    () => new Set(this.conversations.get(this.conversationId())?.members ?? []),
  );
  protected readonly selected = signal<readonly UserState[]>([]);
  protected readonly canAdd = computed(() => this.selected().length > 0 && this.connected());

  protected add(): void {
    if (this.canAdd()) {
      this.dialogRef.close(this.selected().map((u) => u.username));
    }
  }
}
