import { Service, inject } from '@angular/core';
import { HubSocket, RequestFailure } from '@/core/hub/hub-socket';
import { ActionFailure, AddMembersResult, LeaveResult } from '@/core/model/action-result';
import { ConversationsStore } from '@/core/state/conversations-store';
import { MessagesStore } from '@/core/state/messages-store';

/** Group changes, by `addMember` and `leaveGroup`. */
@Service()
export class GroupActions {
  private readonly conversations = inject(ConversationsStore);
  private readonly messages = inject(MessagesStore);
  private readonly socket = inject(HubSocket);

  /** Adds one person at a time, as the client sends one `addMember` each (section 4.6). */
  public async addMembers(
    conversationId: string,
    usernames: readonly string[],
  ): Promise<AddMembersResult> {
    const added: string[] = [];
    const failed: { username: string; reason: ActionFailure }[] = [];
    for (const username of usernames) {
      const failure = await this.addMember(conversationId, username);
      if (failure) {
        failed.push({ username, reason: failure });
      } else {
        added.push(username);
      }
    }
    return { added, failed };
  }

  /**
   * Leaves a group. With `confirm`, the user agreed to leave it empty, which the backend otherwise
   * refuses with `lastMember` (architecture, section 4.5).
   */
  public async leave(conversationId: string, confirm = false): Promise<LeaveResult> {
    try {
      await this.socket.request('leaveGroup', { conversationId, ...(confirm && { confirm }) });
      // `conversationRemoved` usually removed it already.
      this.conversations.remove(conversationId);
      return 'left';
    } catch (error) {
      return error instanceof RequestFailure ? error.reason : 'noResponse';
    }
  }

  /**
   * The backend sends `memberJoined` to the members before answering, and that event adds the
   * member and the notice; if it didn't arrive, the answer does it.
   */
  private async addMember(
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
}
