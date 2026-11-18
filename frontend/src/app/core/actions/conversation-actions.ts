import { Service, inject } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';
import { HubConfig } from '@/core/hub/hub-config';
import { HubSocket, RequestFailure } from '@/core/hub/hub-socket';
import { ServerConversation, toConversation } from '@/core/hub/protocol';
import { ActionFailure, StartResult } from '@/core/model/action-result';
import { directConversationId } from '@/core/model/conversation';
import { normalizeDisplayName } from '@/core/model/names';
import { ConversationsStore } from '@/core/state/conversations-store';
import { CurrentUser } from '@/core/state/current-user';
import { DirectoryStore } from '@/core/state/directory-store';
import { UsersStore } from '@/core/state/users-store';
import { Clock } from '@/core/time/clock';

/**
 * Starting conversations: with the backend, by `openDirect` and `createGroup`; on the fixed data,
 * with the failures of the action scenarios.
 */
@Service()
export class ConversationActions {
  private readonly conversations = inject(ConversationsStore);
  private readonly directory = inject(DirectoryStore);
  private readonly currentUser = inject(CurrentUser);
  private readonly scenarios = inject(Scenarios);
  private readonly clock = inject(Clock);
  private readonly config = inject(HubConfig);
  private readonly socket = inject(HubSocket);
  private readonly users = inject(UsersStore);

  /** Opens the direct chat with someone, starting it if there is none (RF03, `openDirect`). */
  public async openDirect(username: string): Promise<StartResult> {
    if (this.config.live()) {
      return this.start('openDirect', { username });
    }
    const me = this.currentUser.user()?.username ?? '';
    const failure = this.failure([username]);
    if (failure) {
      return failure;
    }
    const conversationId = directConversationId(me, username);
    if (!this.conversations.get(conversationId)) {
      this.directory.makeKnown([username]);
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
  public async createGroup(name: string, usernames: readonly string[]): Promise<StartResult> {
    if (this.config.live()) {
      return this.start('createGroup', { name: normalizeDisplayName(name), members: usernames });
    }
    const me = this.currentUser.user()?.username ?? '';
    const failure = this.failure(usernames);
    if (failure) {
      return failure;
    }
    const conversationId = `g:${crypto.randomUUID()}`;
    this.directory.makeKnown(usernames);
    this.conversations.add({
      conversationId,
      type: 'group',
      name: normalizeDisplayName(name),
      members: [me, ...usernames.filter((u) => u !== me)],
      joinedAt: this.clock.instant().epochMilliseconds,
    });
    return { conversationId };
  }

  /** The answer brings the conversation with each member's state (architecture, section 4.5). */
  private async start(
    action: 'openDirect' | 'createGroup',
    fields: Readonly<Record<string, unknown>>,
  ): Promise<StartResult> {
    try {
      const { conversation } = await this.socket.request<{ conversation: ServerConversation }>(
        action,
        fields,
      );
      conversation.members.forEach((member) => this.users.apply(member));
      this.conversations.add(toConversation(conversation));
      return { conversationId: conversation.conversationId };
    } catch (error) {
      return error instanceof RequestFailure ? error.reason : 'noResponse';
    }
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
}
