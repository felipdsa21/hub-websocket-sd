import { Service, inject } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';
import { directConversationId } from '@/core/model/conversation';
import { normalizeDisplayName } from '@/core/model/names';
import { Clock } from '@/core/time/clock';
import { ConversationsStore } from './conversations-store';
import { CurrentUser } from './current-user';
import { DirectoryStore } from './directory-store';
import { ActionFailure } from './group-actions';
import { UsersStore } from './users-store';

export type StartResult = { readonly conversationId: string } | ActionFailure;

/** Starting conversations on the fixed data, with the failures of the action scenarios. */
@Service()
export class ConversationActions {
  private readonly conversations = inject(ConversationsStore);
  private readonly users = inject(UsersStore);
  private readonly directory = inject(DirectoryStore);
  private readonly currentUser = inject(CurrentUser);
  private readonly scenarios = inject(Scenarios);
  private readonly clock = inject(Clock);

  /** Opens the direct chat with someone, starting it if there is none (RF03, `openDirect`). */
  public openDirect(username: string): StartResult {
    const me = this.currentUser.user()?.username ?? '';
    const failure = this.failure([username]);
    if (failure) {
      return failure;
    }
    const conversationId = directConversationId(me, username);
    if (!this.conversations.get(conversationId)) {
      this.makeKnown([username]);
      this.conversations.add({
        conversationId,
        type: 'direct',
        members: [me, username],
        joinedAt: this.clock.instant().epochMilliseconds,
      });
    }
    return { conversationId };
  }

  /** Creates a group with the user and the chosen people (RF04, `createGroup`). */
  public createGroup(name: string, usernames: readonly string[]): StartResult {
    const me = this.currentUser.user()?.username ?? '';
    const failure = this.failure(usernames);
    if (failure) {
      return failure;
    }
    const conversationId = `g:${crypto.randomUUID()}`;
    this.makeKnown(usernames);
    this.conversations.add({
      conversationId,
      type: 'group',
      name: normalizeDisplayName(name),
      members: [me, ...usernames.filter((u) => u !== me)],
      joinedAt: this.clock.instant().epochMilliseconds,
    });
    return { conversationId };
  }

  private failure(usernames: readonly string[]): ActionFailure | undefined {
    if (this.scenarios.has('sem-resposta')) {
      return 'noResponse';
    }
    const missing = this.scenarios.has('erro-acao')
      ? usernames.slice(0, 1)
      : usernames.filter((u) => !this.directory.get(u));
    return missing.length > 0
      ? { code: 'notFound', message: 'user not found', details: { usernames: missing } }
      : undefined;
  }

  private makeKnown(usernames: readonly string[]): void {
    for (const username of usernames) {
      const state = this.directory.get(username);
      if (state) {
        this.users.apply(state);
      }
    }
  }
}
