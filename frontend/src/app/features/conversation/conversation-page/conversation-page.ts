import { Component, computed, effect, inject, input } from '@angular/core';
import { ConversationsStore } from '@/core/state/conversations-store';

// Placeholder until the conversation view is built.
@Component({
  selector: 'app-conversation-page',
  templateUrl: './conversation-page.html',
})
export class ConversationPage {
  private readonly conversations = inject(ConversationsStore);

  public readonly conversationId = input.required<string>();

  protected readonly conversation = computed(() => this.conversations.get(this.conversationId()));

  constructor() {
    effect(() => this.conversations.open(this.conversationId()));
  }
}
