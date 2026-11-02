import { Service, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { Breakpoints } from '@/core/layout/breakpoints';
import { ConversationActions, StartResult } from '@/core/state/conversation-actions';
import { startFailureText } from '@/shared/format/error-messages';
import { formDialogConfig } from '@/shared/ui/dialog-config';
import { NewChatDialog } from './new-chat-dialog/new-chat-dialog';
import { NewGroup, NewGroupDialog } from './new-group-dialog/new-group-dialog';

/** "Novo chat" and "Novo grupo", from the + button, the "Novo" button and the empty state. */
@Service()
export class NewConversationDialogs {
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);
  private readonly breakpoints = inject(Breakpoints);
  private readonly actions = inject(ConversationActions);

  public openNewChat(): void {
    this.dialog
      .open<NewChatDialog, unknown, string>(
        NewChatDialog,
        formDialogConfig(this.breakpoints.windowSize()),
      )
      .afterClosed()
      .subscribe((username) => {
        if (username) {
          this.finish('chat', this.actions.openDirect(username));
        }
      });
  }

  /** Opens a direct chat from a search result or a person, without the dialog. */
  public openDirect(username: string): void {
    this.finish('chat', this.actions.openDirect(username));
  }

  public openNewGroup(): void {
    this.dialog
      .open<NewGroupDialog, unknown, NewGroup>(
        NewGroupDialog,
        formDialogConfig(this.breakpoints.windowSize()),
      )
      .afterClosed()
      .subscribe((group) => {
        if (group) {
          this.finish('group', this.actions.createGroup(group.name, group.usernames));
        }
      });
  }

  private finish(kind: 'chat' | 'group', result: StartResult): void {
    if (typeof result === 'object' && 'conversationId' in result) {
      void this.router.navigate(['/c', result.conversationId]);
    } else {
      this.snackBar.open(startFailureText(kind, result), undefined, { duration: 6000 });
    }
  }
}
