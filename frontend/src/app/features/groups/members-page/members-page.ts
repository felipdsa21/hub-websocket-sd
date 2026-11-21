import { Component, computed, effect, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { Breakpoints } from '@/core/layout/breakpoints';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { ConnectionBanner } from '@/shared/ui/connection-banner/connection-banner';
import { ScreenHeader } from '@/shared/ui/screen-header/screen-header';
import { GroupDialogs } from '../group-dialogs';
import { MembersPanel } from '../members-panel/members-panel';

/** The members as a screen of their own on phones. */
@Component({
  selector: 'app-members-page',
  imports: [ConnectionBanner, MembersPanel, ScreenHeader],
  templateUrl: './members-page.html',
  styleUrl: './members-page.scss',
})
export class MembersPage {
  private readonly conversations = inject(ConversationsStore);
  private readonly router = inject(Router);
  private readonly breakpoints = inject(Breakpoints);
  protected readonly groupDialogs = inject(GroupDialogs);
  protected readonly lossIndicated = inject(ConnectionStore).lossIndicated;

  public readonly conversationId = input.required<string>();

  protected readonly conversation = computed(() => this.conversations.get(this.conversationId()));
  protected readonly groupName = computed(() => this.conversation()?.name ?? '');

  constructor() {
    // A group the user left or was removed from goes back to the list; wider screens show members
    // next to the conversation instead.
    effect(() => {
      if (!this.conversation() && !this.conversations.loading()) {
        void this.router.navigateByUrl('/');
      } else if (!this.breakpoints.compact()) {
        void this.router.navigate(['/c', this.conversationId()]);
      }
    });
  }
}
