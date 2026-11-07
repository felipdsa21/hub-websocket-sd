import { Component, input } from '@angular/core';
import { MatButton } from '@angular/material/button';
import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogTitle,
} from '@angular/material/dialog';

/** Warns that pending messages may be lost when leaving (RF12). Closes with true to leave. */
@Component({
  selector: 'app-leave-account-dialog',
  imports: [MatButton, MatDialogActions, MatDialogClose, MatDialogContent, MatDialogTitle],
  templateUrl: './leave-account-dialog.html',
})
export class LeaveAccountDialog {
  public readonly pending = input.required<number>();
}
