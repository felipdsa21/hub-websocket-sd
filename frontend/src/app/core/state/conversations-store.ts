import { Service, computed, inject, signal } from '@angular/core';
import { Conversation } from '@/core/model/conversation';
import { compareConversations, hasNewActivity } from './conversation-rules';
import { CurrentUser } from './current-user';

@Service()
export class ConversationsStore {
  private readonly currentUser = inject(CurrentUser);
  private readonly conversations = signal<readonly Conversation[]>([]);
  /** `sentAt` of the last message seen in each conversation in this browser (RF10). */
  private readonly seen = signal<ReadonlyMap<string, number>>(new Map());
  /** Conversations opened in this session; the others are dimmed while offline. */
  private readonly opened = signal<ReadonlySet<string>>(new Set());

  public readonly sorted = computed(() => [...this.conversations()].sort(compareConversations));

  public readonly withNewActivity = computed(() => {
    const me = this.currentUser.user()?.username ?? '';
    const seen = this.seen();
    return new Set(
      this.conversations()
        .filter((c) => hasNewActivity(c, me, seen.get(c.conversationId)))
        .map((c) => c.conversationId),
    );
  });

  public readonly openedIds = this.opened.asReadonly();
  /** True until the list arrives after entering. */
  public readonly loading = signal(false);

  public get(conversationId: string): Conversation | undefined {
    return this.conversations().find((c) => c.conversationId === conversationId);
  }

  public reset(conversations: readonly Conversation[], seen: ReadonlyMap<string, number>): void {
    this.conversations.set(conversations);
    this.seen.set(seen);
    this.opened.set(new Set());
  }

  public add(conversation: Conversation): void {
    this.conversations.update((list) => [
      ...list.filter((c) => c.conversationId !== conversation.conversationId),
      conversation,
    ]);
  }

  public remove(conversationId: string): void {
    this.conversations.update((list) => list.filter((c) => c.conversationId !== conversationId));
  }

  /** Records a newer last message (architecture, section 4.6). */
  public updateLastMessage(conversationId: string, sentAt: number, sender: string): void {
    this.conversations.update((list) =>
      list.map((c) =>
        c.conversationId === conversationId &&
        (c.lastMessageAt === undefined ||
          sentAt > c.lastMessageAt ||
          (sentAt === c.lastMessageAt && sender > (c.lastMessageBy ?? '')))
          ? { ...c, lastMessageAt: sentAt, lastMessageBy: sender }
          : c,
      ),
    );
  }

  /** Marks the conversation as opened and its last message as seen. */
  public open(conversationId: string): void {
    this.opened.update((ids) => new Set(ids).add(conversationId));
    this.markSeen(conversationId);
  }

  public markSeen(conversationId: string): void {
    const lastMessageAt = this.get(conversationId)?.lastMessageAt;
    if (lastMessageAt !== undefined) {
      this.seen.update((seen) => new Map(seen).set(conversationId, lastMessageAt));
    }
  }
}
