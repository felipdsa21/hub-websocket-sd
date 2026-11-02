import { Service, inject, inputBinding } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { Breakpoints } from '@/core/layout/breakpoints';
import { ConversationsStore } from '@/core/state/conversations-store';
import { DirectoryStore } from '@/core/state/directory-store';
import { GroupActions } from '@/core/state/group-actions';
import { UsersStore } from '@/core/state/users-store';
import { nameWithUsername, repeatedDisplayNames } from '@/shared/format/display-names';
import { addMembersNotice, leaveFailureText } from '@/shared/format/error-messages';
import { formDialogConfig } from '@/shared/ui/dialog-config';
import { AddPeopleDialog } from './add-people-dialog/add-people-dialog';
import { LeaveGroupDialog } from './leave-group-dialog/leave-group-dialog';
import { MembersSheet } from './members-sheet/members-sheet';

/** The group flows that go through dialogs, shared by the conversation header and the members. */
@Service()
export class GroupDialogs {
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);
  private readonly breakpoints = inject(Breakpoints);
  private readonly conversations = inject(ConversationsStore);
  private readonly users = inject(UsersStore);
  private readonly directory = inject(DirectoryStore);
  private readonly actions = inject(GroupActions);

  /** The members as a modal side sheet, between phone and desktop widths. */
  public openMembersSheet(conversationId: string): void {
    this.dialog.open(MembersSheet, {
      bindings: [inputBinding('conversationId', () => conversationId)],
      position: { top: '0', right: '0' },
      width: '320px',
      height: '100%',
      maxHeight: '100%',
      panelClass: 'side-sheet-panel',
      autoFocus: 'dialog',
      ariaLabelledBy: 'members-title',
    });
  }

  public openAddPeople(conversationId: string): void {
    const ref = this.dialog.open<AddPeopleDialog, unknown, readonly string[]>(
      AddPeopleDialog,
      formDialogConfig(this.breakpoints.windowSize(), [
        inputBinding('conversationId', () => conversationId),
      ]),
    );
    ref.afterClosed().subscribe((usernames) => {
      if (!usernames?.length) {
        return;
      }
      const result = this.actions.addMembers(conversationId, usernames);
      const people = new Map(
        usernames
          .map((u) => this.users.get(u) ?? this.directory.get(u))
          .filter((u) => u !== undefined)
          .map((u) => [u.username, u]),
      );
      const repeated = repeatedDisplayNames(people.values());
      const notice = addMembersNotice(result, (username) => {
        const user = people.get(username);
        return user ? nameWithUsername(user, repeated) : `@${username}`;
      });
      if (notice) {
        this.snackBar.open(notice, undefined, { duration: 6000 });
      }
    });
  }

  public confirmLeave(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return;
    }
    const groupName = conversation.name ?? '';
    const lastMember = conversation.members.length === 1;
    const ref = this.dialog.open<LeaveGroupDialog, unknown, boolean>(LeaveGroupDialog, {
      bindings: [
        inputBinding('groupName', () => groupName),
        inputBinding('lastMember', () => lastMember),
      ],
      width: '400px',
    });
    ref.afterClosed().subscribe((confirmed) => {
      if (!confirmed) {
        return;
      }
      const result = this.actions.leave(conversationId);
      if (result === 'left') {
        this.dialog.closeAll();
        void this.router.navigateByUrl('/');
        this.snackBar.open(`Você saiu de ${groupName}.`, undefined, { duration: 4000 });
      } else {
        this.snackBar.open(leaveFailureText(result), undefined, { duration: 6000 });
      }
    });
  }
}
