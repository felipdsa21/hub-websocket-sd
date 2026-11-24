import { Component, computed, inject, signal } from '@angular/core';
import { FormField, form, validate } from '@angular/forms/signals';
import { MatButton } from '@angular/material/button';
import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatError, MatFormField, MatHint, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { isValidDisplayName } from '@/core/model/names';
import { UserState } from '@/core/model/user';
import { ConnectionStore } from '@/core/state/connection-store';
import { CurrentUser } from '@/core/state/current-user';
import { DialogHeader } from '@/shared/ui/dialog-header/dialog-header';
import { PeoplePicker } from '@/shared/ui/people-picker/people-picker';

export interface NewGroup {
  readonly name: string;
  readonly usernames: readonly string[];
}

/** Closes with the group's name and members. */
@Component({
  selector: 'app-new-group-dialog',
  imports: [
    DialogHeader,
    FormField,
    MatButton,
    MatDialogActions,
    MatDialogClose,
    MatDialogContent,
    MatError,
    MatFormField,
    MatHint,
    MatIcon,
    MatInput,
    MatLabel,
    MatSuffix,
    PeoplePicker,
  ],
  templateUrl: './new-group-dialog.html',
  styleUrl: './new-group-dialog.scss',
})
export class NewGroupDialog {
  private readonly dialogRef = inject(MatDialogRef<NewGroupDialog, NewGroup>);
  private readonly currentUser = inject(CurrentUser);
  private readonly connected = inject(ConnectionStore).connected;

  protected readonly me = computed(() => new Set([this.currentUser.user()?.username ?? '']));
  protected readonly selected = signal<readonly UserState[]>([]);

  private readonly model = signal({ name: '' });
  protected readonly groupForm = form(this.model, (path) => {
    // Group names follow the display name rule (architecture, section 4.5).
    validate(path.name, ({ value }) =>
      isValidDisplayName(value()) ? undefined : { kind: 'groupName' },
    );
  });

  protected readonly canCreate = computed(
    () => this.groupForm().valid() && this.selected().length > 0 && this.connected(),
  );

  protected create(): void {
    if (this.canCreate()) {
      this.dialogRef.close({
        name: this.model().name,
        usernames: this.selected().map((u) => u.username),
      });
    }
  }
}
