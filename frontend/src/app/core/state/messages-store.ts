import { Service, inject, signal } from '@angular/core';
import { Fixtures } from '@/core/fixtures/fixtures';
import { Scenarios } from '@/core/fixtures/scenarios';
import { Message, OutgoingMessage, compareMessages, messageSk } from '@/core/model/message';
import { MemberNotice } from '@/core/model/notice';
import { Clock } from '@/core/time/clock';
import { ConnectionStore } from './connection-store';
import { ConversationsStore } from './conversations-store';
import { CurrentUser } from './current-user';

/** Messages per page of history (architecture, section 4.4). */
export const HISTORY_PAGE_SIZE = 50;

/** Loading of a conversation's history: the first page, then the older ones. */
export type HistoryStatus = 'loading' | 'error' | 'loaded' | 'loading-older' | 'older-error';

interface History {
  readonly status: HistoryStatus;
  readonly messages: readonly Message[];
  readonly hasOlder: boolean;
}

@Service()
export class MessagesStore {
  private readonly conversations = inject(ConversationsStore);
  private readonly currentUser = inject(CurrentUser);
  private readonly connection = inject(ConnectionStore);
  private readonly scenarios = inject(Scenarios);
  private readonly clock = inject(Clock);

  /** Everything the backend has, page by page; with the fixed data, it is all known up front. */
  private backend: readonly Message[] = [];
  private readonly histories = signal<ReadonlyMap<string, History>>(new Map());
  private readonly outgoing = signal<readonly OutgoingMessage[]>([]);
  private readonly notices = signal<readonly MemberNotice[]>([]);

  public reset(data: Fixtures | null): void {
    this.backend = data ? [...data.messages].sort(compareMessages) : [];
    this.histories.set(new Map());
    this.notices.set(data?.notices ?? []);
    this.outgoing.set(data ? this.scenarioOutgoing(data) : []);
  }

  public history(conversationId: string): History | undefined {
    return this.histories().get(conversationId);
  }

  public outgoingIn(conversationId: string): readonly OutgoingMessage[] {
    return this.outgoing().filter((m) => m.conversationId === conversationId);
  }

  public pendingCount(): number {
    return this.outgoing().filter((m) => !m.error).length;
  }

  public noticesIn(conversationId: string): readonly MemberNotice[] {
    return this.notices().filter((n) => n.conversationId === conversationId);
  }

  /** Loads the latest page, unless it is loaded or loading already (RF06). */
  public open(conversationId: string): void {
    const status = this.history(conversationId)?.status;
    if (status === undefined || status === 'error') {
      this.loadLatest(conversationId);
    }
  }

  public loadLatest(conversationId: string): void {
    if (this.scenarios.has('carregando')) {
      this.setHistory(conversationId, { status: 'loading', messages: [], hasOlder: false });
      return;
    }
    if (this.scenarios.has('erro-historico')) {
      this.setHistory(conversationId, { status: 'error', messages: [], hasOlder: false });
      return;
    }
    const all = this.backendIn(conversationId);
    this.setHistory(conversationId, {
      status: 'loaded',
      messages: all.slice(-HISTORY_PAGE_SIZE),
      hasOlder: all.length > HISTORY_PAGE_SIZE,
    });
  }

  public loadOlder(conversationId: string): void {
    const history = this.history(conversationId);
    if (!history?.hasOlder || history.status === 'loading-older') {
      return;
    }
    if (this.scenarios.has('carregando')) {
      this.setHistory(conversationId, { ...history, status: 'loading-older' });
      return;
    }
    if (this.scenarios.has('erro-historico')) {
      this.setHistory(conversationId, { ...history, status: 'older-error' });
      return;
    }
    const first = history.messages[0];
    const older = this.backendIn(conversationId).filter((m) => !first || m.sk < first.sk);
    this.setHistory(conversationId, {
      status: 'loaded',
      messages: [...older.slice(-HISTORY_PAGE_SIZE), ...history.messages],
      hasOlder: older.length > HISTORY_PAGE_SIZE,
    });
  }

  /**
   * Sends a message. With the fixed data it is confirmed at once, unless a scenario or the lost
   * connection keeps it pending, or a scenario rejects it (RF12).
   */
  public send(conversationId: string, text: string, messageId = crypto.randomUUID()): void {
    if (this.scenarios.has('nao-enviada')) {
      this.outgoing.update((list) => [
        ...list,
        {
          conversationId,
          messageId,
          text,
          error: { code: 'invalidRequest', message: 'text: invalid', details: { field: 'text' } },
        },
      ]);
      return;
    }
    if (!this.connection.connected() || this.scenarios.has('pendentes')) {
      this.outgoing.update((list) => [...list, { conversationId, messageId, text }]);
      return;
    }
    const sender = this.currentUser.user()?.username ?? '';
    const sentAt = this.clock.instant().epochMilliseconds;
    const message: Message = {
      conversationId,
      sk: messageSk(sentAt, sender, messageId),
      messageId,
      sender,
      text,
      sentAt,
    };
    this.backend = [...this.backend, message];
    const history = this.history(conversationId);
    if (history) {
      this.setHistory(conversationId, { ...history, messages: [...history.messages, message] });
    }
    this.conversations.updateLastMessage(conversationId, sentAt, sender);
    this.conversations.markSeen(conversationId);
  }

  public discard(messageId: string): void {
    this.outgoing.update((list) => list.filter((m) => m.messageId !== messageId));
  }

  private backendIn(conversationId: string): Message[] {
    return this.backend.filter((m) => m.conversationId === conversationId);
  }

  private setHistory(conversationId: string, history: History): void {
    this.histories.update((map) => new Map(map).set(conversationId, history));
  }

  /** The unconfirmed messages the "pendentes" and "nao-enviada" scenarios start with. */
  private scenarioOutgoing(data: Fixtures): OutgoingMessage[] {
    const bruno = data.conversations.find(
      (c) => c.type === 'direct' && c.members.includes('bruno'),
    );
    if (!bruno) {
      return [];
    }
    const conversationId = bruno.conversationId;
    const outgoing: OutgoingMessage[] = [];
    if (this.scenarios.has('pendentes')) {
      outgoing.push(
        {
          conversationId,
          messageId: crypto.randomUUID(),
          text: 'Já coloquei as latências do T8 também.',
        },
        {
          conversationId,
          messageId: crypto.randomUUID(),
          text: 'Me avisa se faltar alguma evidência.',
        },
      );
    }
    if (this.scenarios.has('nao-enviada')) {
      outgoing.push({
        conversationId,
        messageId: crypto.randomUUID(),
        text: 'Segue o resumo do T5 para conferir.',
        error: { code: 'invalidRequest', message: 'text: invalid', details: { field: 'text' } },
      });
    }
    return outgoing;
  }
}
