import { Service, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { ConversationsStore } from '@/core/state/conversations-store';
import { MessagesStore } from '@/core/state/messages-store';
import { TelemetryStore } from '@/core/state/telemetry-store';
import { UsersStore } from '@/core/state/users-store';
import { HubSocket } from './hub-socket';
import { HubEvent, ServerConversation, SyncData, toConversation } from './protocol';

/** Applies the events the backend sends without a request to the stores (section 4.2). */
@Service()
export class HubEvents {
  private readonly socket = inject(HubSocket);
  private readonly conversations = inject(ConversationsStore);
  private readonly messages = inject(MessagesStore);
  private readonly users = inject(UsersStore);
  private readonly telemetry = inject(TelemetryStore);

  private subscription?: Subscription;
  /** Events held until the lists of the entry are loaded; `null` once they are applied. */
  private held: HubEvent[] | null = null;
  private syncing = false;

  /** Starts listening and holds the events until `release()`. */
  public start(): void {
    this.stop();
    this.held = [];
    this.subscription = this.socket.events.subscribe((event) => {
      if (this.held) {
        this.held.push(event);
      } else {
        this.apply(event);
      }
    });
  }

  /** Applies the held events, in arrival order, and the next ones as they arrive. */
  public release(): void {
    const held = this.held ?? [];
    this.held = null;
    held.forEach((event) => this.apply(event));
  }

  public stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.held = null;
  }

  private apply(event: HubEvent): void {
    switch (event.type) {
      case 'message': {
        const { conversationId, sk, messageId, sender, text, sentAt } = event;
        const message = { conversationId, sk, messageId, sender, text, sentAt };
        // A message can arrive before the `conversationAdded` of its conversation (section 4.3).
        if (!this.conversations.get(message.conversationId)) {
          void this.syncConversations();
        }
        this.messages.receive(message);
        break;
      }
      case 'presence': {
        const { username, displayName, online, version } = event;
        // A client log used in the tests (architecture, section 4.6).
        console.info(`Presence: ${username} ${online ? 'online' : 'offline'}, version ${version}.`);
        this.telemetry.record(
          'presence',
          `@${username} ${online ? 'online' : 'offline'} (v${version})`,
        );
        this.users.apply({ username, displayName, online, version });
        break;
      }
      case 'conversationAdded':
        this.addConversation(event.conversation);
        break;
      case 'conversationRemoved':
        this.conversations.remove(event.conversationId);
        break;
      case 'memberJoined':
        this.users.apply(event.member);
        this.conversations.addMember(event.conversationId, event.member.username);
        this.messages.addNotice(event.conversationId, 'joined', event.member.username);
        break;
      case 'memberLeft':
        this.conversations.removeMember(event.conversationId, event.username);
        this.messages.addNotice(event.conversationId, 'left', event.username);
        break;
    }
  }

  private addConversation(conversation: ServerConversation): void {
    for (const member of conversation.members) {
      this.users.apply(member);
    }
    this.conversations.add(toConversation(conversation));
  }

  /** Brings the conversations the client doesn't know yet, as `sync` lists them. */
  private async syncConversations(): Promise<void> {
    if (this.syncing) {
      return;
    }
    this.syncing = true;
    try {
      const data = await this.socket.request<SyncData>('sync');
      for (const conversation of data.conversations) {
        if (!this.conversations.get(conversation.conversationId)) {
          this.addConversation(conversation);
        }
      }
    } catch (error) {
      console.warn('sync failed:', error);
    } finally {
      this.syncing = false;
    }
  }
}
