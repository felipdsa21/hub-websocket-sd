import { Service, inject } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';
import { ActionFailure, AddMembersResult, LeaveResult } from '@/core/model/action-result';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { DirectoryStore } from '@/core/state/directory-store';
import { MessagesStore } from '@/core/state/messages-store';

/**
 * Group changes on the fixed data. The "erro-acao" and "sem-resposta" scenarios make them fail as
 * the backend could: with an error, or without a response.
 */
@Service()
export class GroupActions {
  private readonly conversations = inject(ConversationsStore);
  private readonly messages = inject(MessagesStore);
  private readonly directory = inject(DirectoryStore);
  private readonly connection = inject(ConnectionStore);
  private readonly scenarios = inject(Scenarios);

  /** Adds one person at a time, as the client sends one `addMember` each (section 4.6). */
  public addMembers(conversationId: string, usernames: readonly string[]): AddMembersResult {
    const added: string[] = [];
    const failed: { username: string; reason: ActionFailure }[] = [];
    for (const [index, username] of usernames.entries()) {
      const failure = this.addMemberFailure(conversationId, username, index);
      if (failure) {
        failed.push({ username, reason: failure });
        continue;
      }
      this.directory.makeKnown([username]);
      this.conversations.addMember(conversationId, username);
      this.messages.addNotice(conversationId, 'joined', username);
      added.push(username);
    }
    return { added, failed };
  }

  public leave(conversationId: string): LeaveResult {
    if (this.scenarios.has('sem-resposta')) {
      return 'noResponse';
    }
    if (this.scenarios.has('erro-acao')) {
      return { code: 'conflict', message: 'transaction conflict' };
    }
    this.conversations.remove(conversationId);
    return 'left';
  }

  private addMemberFailure(
    conversationId: string,
    username: string,
    index: number,
  ): ActionFailure | undefined {
    if (!this.connection.connected() || this.scenarios.has('sem-resposta')) {
      return 'noResponse';
    }
    // In the scenario, the first person goes in and the others were already added by someone else.
    if (this.scenarios.has('erro-acao') && index > 0) {
      return { code: 'invalidOperation', message: 'already a member' };
    }
    if (!this.directory.get(username)) {
      return { code: 'notFound', message: 'user not found' };
    }
    if (this.conversations.get(conversationId)?.members.includes(username)) {
      return { code: 'invalidOperation', message: 'already a member' };
    }
    return undefined;
  }
}
