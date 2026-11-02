import { Component, computed, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogRef,
} from '@angular/material/dialog';
import { UserState } from '@/core/model/user';
import { CurrentUser } from '@/core/state/current-user';
import { DialogHeader } from '@/shared/ui/dialog-header/dialog-header';
import { PeoplePicker } from '@/shared/ui/people-picker/people-picker';

/** Closes with the chosen person's username. */
@Component({
  selector: 'app-new-chat-dialog',
  imports: [
    DialogHeader,
    MatButton,
    MatDialogActions,
    MatDialogClose,
    MatDialogContent,
    PeoplePicker,
  ],
  templateUrl: './new-chat-dialog.html',
})
export class NewChatDialog {
  private readonly dialogRef = inject(MatDialogRef<NewChatDialog, string>);
  private readonly currentUser = inject(CurrentUser);

  protected readonly me = computed(() => new Set([this.currentUser.user()?.username ?? '']));

  protected pick(user: UserState): void {
    this.dialogRef.close(user.username);
  }
}
