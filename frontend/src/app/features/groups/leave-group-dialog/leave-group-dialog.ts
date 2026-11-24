import { Component, input } from '@angular/core';
import { MatButton } from '@angular/material/button';
import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogTitle,
} from '@angular/material/dialog';

/** Closes with true when the user confirms. */
@Component({
  selector: 'app-leave-group-dialog',
  imports: [MatButton, MatDialogActions, MatDialogClose, MatDialogContent, MatDialogTitle],
  templateUrl: './leave-group-dialog.html',
})
export class LeaveGroupDialog {
  public readonly groupName = input.required<string>();
  /** The last member is warned that the group becomes inaccessible (RF04). */
  public readonly lastMember = input.required<boolean>();
}
