import { Component, inject, input } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { GroupDialogs } from '../group-dialogs';
import { MembersHeader } from '../members-header/members-header';
import { MembersPanel } from '../members-panel/members-panel';

/** Side sheet with the members: inline on desktop, modal at intermediate widths. */
@Component({
  selector: 'app-members-sheet',
  imports: [MembersHeader, MembersPanel],
  templateUrl: './members-sheet.html',
  styleUrl: './members-sheet.scss',
})
export class MembersSheet {
  protected readonly groupDialogs = inject(GroupDialogs);
  protected readonly dialogRef = inject(MatDialogRef<MembersSheet>);

  public readonly conversationId = input.required<string>();
}
