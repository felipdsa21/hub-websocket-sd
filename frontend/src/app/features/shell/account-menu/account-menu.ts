import { Component, inject, inputBinding } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatDivider } from '@angular/material/divider';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { Router } from '@angular/router';
import { ConnectionStore } from '@/core/state/connection-store';
import { MessagesStore } from '@/core/state/messages-store';
import { SessionStore } from '@/core/state/session-store';
import { DisplayNameDialog } from '@/features/account/display-name-dialog/display-name-dialog';
import { LeaveAccountDialog } from '@/features/account/leave-account-dialog/leave-account-dialog';
import { Avatar } from '@/shared/ui/avatar/avatar';

/**
 * The user's avatar and menu. Its dot shows this tab's connection, not the presence contacts see.
 */
@Component({
  selector: 'app-account-menu',
  imports: [Avatar, MatDivider, MatIconButton, MatMenu, MatMenuItem, MatMenuTrigger],
  templateUrl: './account-menu.html',
  styleUrl: './account-menu.scss',
})
export class AccountMenu {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly messages = inject(MessagesStore);
  protected readonly connected = inject(ConnectionStore).connected;

  protected readonly user = this.session.user;

  protected changeDisplayName(): void {
    const displayName = this.user()?.displayName ?? '';
    this.dialog
      .open<DisplayNameDialog, unknown, string>(DisplayNameDialog, {
        bindings: [inputBinding('displayName', () => displayName)],
        width: '400px',
      })
      .afterClosed()
      .subscribe((name) => {
        if (name) {
          this.session.changeDisplayName(name);
        }
      });
  }

  /** With pending messages, the user confirms that they may be lost (RF12). */
  protected leave(): void {
    const pending = this.messages.pendingCount();
    if (pending === 0) {
      this.signOut();
      return;
    }
    this.dialog
      .open<LeaveAccountDialog, unknown, boolean>(LeaveAccountDialog, {
        bindings: [inputBinding('pending', () => pending)],
        width: '400px',
      })
      .afterClosed()
      .subscribe((confirmed) => {
        if (confirmed) {
          this.signOut();
        }
      });
  }

  private signOut(): void {
    this.session.leave();
    void this.router.navigateByUrl('/entrar');
  }
}
