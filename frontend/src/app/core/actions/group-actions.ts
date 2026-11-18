import { Service, inject } from '@angular/core';
import { Scenarios } from '@/core/fixtures/scenarios';
import { HubConfig } from '@/core/hub/hub-config';
import { HubSocket, RequestFailure } from '@/core/hub/hub-socket';
import { ActionFailure, AddMembersResult, LeaveResult } from '@/core/model/action-result';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { DirectoryStore } from '@/core/state/directory-store';
import { MessagesStore } from '@/core/state/messages-store';

/**
 * Group changes: with the backend, by `addMember` and `leaveGroup`; on the fixed data, the
 * "erro-acao" and "sem-resposta" scenarios make them fail as the backend could: with an error, or
 * without a response.
 */
@Service()
export class GroupActions {
  private readonly conversations = inject(ConversationsStore);
  private readonly messages = inject(MessagesStore);
  private readonly directory = inject(DirectoryStore);
  private readonly connection = inject(ConnectionStore);
  private readonly scenarios = inject(Scenarios);
  private readonly config = inject(HubConfig);
  private readonly socket = inject(HubSocket);

  /** Adds one person at a time, as the client sends one `addMember` each (section 4.6). */
  public async addMembers(
    conversationId: string,
    usernames: readonly string[],
  ): Promise<AddMembersResult> {
    const added: string[] = [];
    const failed: { username: string; reason: ActionFailure }[] = [];
    for (const [index, username] of usernames.entries()) {
      const live = this.config.live();
      const failure = live
        ? await this.addMemberLive(conversationId, username)
        : this.addMemberFailure(conversationId, username, index);
      if (failure) {
        failed.push({ username, reason: failure });
        continue;
      }
      if (!live) {
        this.directory.makeKnown([username]);
        this.conversations.addMember(conversationId, username);
        this.messages.addNotice(conversationId, 'joined', username);
      }
      added.push(username);
    }
    return { added, failed };
  }

  /**
   * Leaves a group. With `confirm`, the user agreed to leave it empty, which the backend otherwise
   * refuses with `lastMember` (architecture, section 4.5).
   */
  public async leave(conversationId: string, confirm = false): Promise<LeaveResult> {
    if (this.config.live()) {
      try {
        await this.socket.request('leaveGroup', { conversationId, ...(confirm && { confirm }) });
        // `conversationRemoved` usually removed it already.
        this.conversations.remove(conversationId);
        return 'left';
      } catch (error) {
        return error instanceof RequestFailure ? error.reason : 'noResponse';
      }
    }
    if (this.scenarios.has('sem-resposta')) {
      return 'noResponse';
    }
    if (this.scenarios.has('erro-acao')) {
      return { code: 'conflict', message: 'transaction conflict' };
    }
    this.conversations.remove(conversationId);
    return 'left';
  }

  /**
   * The backend sends `memberJoined` to the members before answering, and that event adds the
   * member and the notice; if it didn't arrive, the answer does it.
   */
  private async addMemberLive(
    conversationId: string,
    username: string,
  ): Promise<ActionFailure | undefined> {
    try {
      await this.socket.request('addMember', { conversationId, username });
    } catch (error) {
      return error instanceof RequestFailure ? error.reason : 'noResponse';
    }
    if (!this.conversations.get(conversationId)?.members.includes(username)) {
      this.conversations.addMember(conversationId, username);
      this.messages.addNotice(conversationId, 'joined', username);
    }
    return undefined;
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
