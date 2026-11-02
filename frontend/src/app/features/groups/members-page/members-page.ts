import { Component, computed, effect, inject, input } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { Router, RouterLink } from '@angular/router';
import { Breakpoints } from '@/core/layout/breakpoints';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { ConnectionBanner } from '@/shared/ui/connection-banner/connection-banner';
import { GroupDialogs } from '../group-dialogs';
import { MembersPanel } from '../members-panel/members-panel';

/** The members as a screen of their own on phones. */
@Component({
  selector: 'app-members-page',
  imports: [ConnectionBanner, MatIcon, MatIconButton, MembersPanel, RouterLink],
  templateUrl: './members-page.html',
  styleUrl: './members-page.scss',
})
export class MembersPage {
  private readonly conversations = inject(ConversationsStore);
  private readonly router = inject(Router);
  private readonly breakpoints = inject(Breakpoints);
  protected readonly groupDialogs = inject(GroupDialogs);
  protected readonly connected = inject(ConnectionStore).connected;

  public readonly conversationId = input.required<string>();

  protected readonly groupName = computed(
    () => this.conversations.get(this.conversationId())?.name ?? '',
  );

  constructor() {
    // Wider screens show the members next to the conversation instead.
    effect(() => {
      if (this.breakpoints.windowSize() !== 'compact') {
        void this.router.navigate(['/c', this.conversationId()]);
      }
    });
  }
}
