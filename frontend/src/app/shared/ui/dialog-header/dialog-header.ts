import { Component, computed, inject, input } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatDialogClose, MatDialogTitle } from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { Breakpoints } from '@/core/layout/breakpoints';

/**
 * A dialog's title. On phones, where dialogs open full screen, it becomes a header with a close
 * button and the projected main action, as in the design.
 */
@Component({
  selector: 'app-dialog-header',
  imports: [MatDialogClose, MatDialogTitle, MatIcon, MatIconButton],
  templateUrl: './dialog-header.html',
  styleUrl: './dialog-header.scss',
})
export class DialogHeader {
  private readonly breakpoints = inject(Breakpoints);

  public readonly title = input.required<string>();

  protected readonly compact = computed(() => this.breakpoints.windowSize() === 'compact');
}
