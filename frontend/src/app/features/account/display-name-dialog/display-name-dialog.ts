import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormField, form, validate } from '@angular/forms/signals';
import { MatButton, MatIconButton } from '@angular/material/button';
import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatError, MatFormField, MatHint, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { isValidDisplayName } from '@/core/model/names';
import { ConnectionStore } from '@/core/state/connection-store';

/** Closes with the new display name (RF01). */
@Component({
  selector: 'app-display-name-dialog',
  imports: [
    FormField,
    MatButton,
    MatDialogActions,
    MatDialogClose,
    MatDialogContent,
    MatDialogTitle,
    MatError,
    MatFormField,
    MatHint,
    MatIcon,
    MatIconButton,
    MatInput,
    MatLabel,
    MatSuffix,
  ],
  templateUrl: './display-name-dialog.html',
  styleUrl: './display-name-dialog.scss',
})
export class DisplayNameDialog {
  private readonly dialogRef = inject(MatDialogRef<DisplayNameDialog, string>);
  private readonly connected = inject(ConnectionStore).connected;

  /** The current name, which the field starts with. */
  public readonly displayName = input.required<string>();

  protected readonly model = linkedSignal(() => ({ displayName: this.displayName() }));
  protected readonly nameForm = form(this.model, (path) => {
    validate(path.displayName, ({ value }) =>
      isValidDisplayName(value()) ? undefined : { kind: 'displayName' },
    );
  });

  protected readonly invalid = computed(
    () => this.nameForm.displayName().touched() && this.nameForm.displayName().invalid(),
  );
  /** Changing the name opens a new connection, so it needs one (RF08). */
  protected readonly canSave = computed(() => this.nameForm().valid() && this.connected());

  protected clear(): void {
    this.model.set({ displayName: '' });
    this.nameForm.displayName().markAsTouched();
  }

  protected save(event: Event): void {
    event.preventDefault();
    if (this.canSave()) {
      this.dialogRef.close(this.model().displayName);
    }
  }
}
