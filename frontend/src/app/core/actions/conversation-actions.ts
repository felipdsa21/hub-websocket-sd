import { Service, inject } from '@angular/core';
import { HubSocket, RequestFailure } from '@/core/hub/hub-socket';
import { ServerConversation, toConversation } from '@/core/hub/protocol';
import { StartResult } from '@/core/model/action-result';
import { normalizeDisplayName } from '@/core/model/names';
import { ConversationsStore } from '@/core/state/conversations-store';
import { UsersStore } from '@/core/state/users-store';

/** Starting conversations, by `openDirect` and `createGroup`. */
@Service()
export class ConversationActions {
  private readonly conversations = inject(ConversationsStore);
  private readonly socket = inject(HubSocket);
  private readonly users = inject(UsersStore);

  /** Opens the direct chat with someone, starting it if there is none (RF03, `openDirect`). */
  public async openDirect(username: string): Promise<StartResult> {
    return this.start('openDirect', { username });
  }

  /** Creates a group with the user and the chosen people (RF04, `createGroup`). */
  public async createGroup(name: string, usernames: readonly string[]): Promise<StartResult> {
    return this.start('createGroup', { name: normalizeDisplayName(name), members: usernames });
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
}
