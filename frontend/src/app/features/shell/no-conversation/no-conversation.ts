import { Component, computed, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { NewConversationDialogs } from '@/features/new-conversation/new-conversation-dialogs';

/** The open-conversation area when none is selected, on wider screens. */
@Component({
  selector: 'app-no-conversation',
  imports: [MatButton, MatIcon],
  templateUrl: './no-conversation.html',
  styleUrl: './no-conversation.scss',
})
export class NoConversation {
  private readonly conversations = inject(ConversationsStore);
  protected readonly connected = inject(ConnectionStore).connected;
  protected readonly newConversations = inject(NewConversationDialogs);
  protected readonly empty = computed(
    () => !this.conversations.loading() && this.conversations.sorted().length === 0,
  );
}
