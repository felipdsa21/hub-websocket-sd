import { Component, inject, input } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatDialogClose, MatDialogTitle } from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { GroupDialogs } from '../group-dialogs';
import { MembersPanel } from '../members-panel/members-panel';

/** Side sheet with the members: inline on desktop, modal at intermediate widths. */
@Component({
  selector: 'app-members-sheet',
  imports: [MatDialogClose, MatDialogTitle, MatIcon, MatIconButton, MembersPanel],
  templateUrl: './members-sheet.html',
  styleUrl: './members-sheet.scss',
})
export class MembersSheet {
  protected readonly groupDialogs = inject(GroupDialogs);

  public readonly conversationId = input.required<string>();
}
