import { DOCUMENT, DestroyRef, Service, inject, signal } from '@angular/core';
import { HubSocket, RequestFailure } from '@/core/hub/hub-socket';
import { HistoryPage } from '@/core/hub/protocol';
import { HubError } from '@/core/model/error';
import {
  Message,
  OutgoingMessage,
  compareMessages,
  skAfterInstant,
  skBeforeInstant,
} from '@/core/model/message';
import { MemberNotice } from '@/core/model/notice';
import { ConnectionStore } from './connection-store';
import { ConversationsStore } from './conversations-store';
import { CurrentUser } from './current-user';
import { TelemetryStore } from './telemetry-store';

/** Overlap subtracted from `since` and `after` on reconnection (architecture, section 4.4). */
export const SYNC_OVERLAP_MS = 30_000;

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
  private readonly socket = inject(HubSocket);
  private readonly telemetry = inject(TelemetryStore);
  private readonly window = inject(DOCUMENT).defaultView;

  /** Messages with a `sendMessage` waiting for confirmation; one per conversation (section 4.4). */
  private readonly inFlight = new Set<string>();
  /** Timestamp (`performance.now()`) of each in-flight send, to measure confirmation RTT. */
  private readonly sentAtPerf = new Map<string, number>();
  /** Loaded conversations whose reconnect catch-up did not finish and must retry next reconnect. */
  private readonly pendingSync = new Set<string>();
  /** Latest `sentAt` received from the backend, used to compute `sync` `since` (section 4.4). */
  private lastReceived = 0;

  private readonly histories = signal<ReadonlyMap<string, History>>(new Map());
  private readonly outgoing = signal<readonly OutgoingMessage[]>([]);
  private readonly notices = signal<readonly MemberNotice[]>([]);

  constructor() {
    const win = this.window;
    if (win) {
      // Warns before reload or close while messages are still pending in memory (RF12, 4.6).
      const onBeforeUnload = (event: BeforeUnloadEvent) => {
        if (this.pendingCount() > 0) {
          event.preventDefault();
          event.returnValue = '';
        }
      };
      win.addEventListener('beforeunload', onBeforeUnload);
      inject(DestroyRef).onDestroy(() => win.removeEventListener('beforeunload', onBeforeUnload));
    }
  }

  public reset(): void {
    this.inFlight.clear();
    this.sentAtPerf.clear();
    this.pendingSync.clear();
    this.lastReceived = 0;
    this.histories.set(new Map());
    this.notices.set([]);
    this.outgoing.set([]);
  }

  public lastReceivedSentAt(): number | undefined {
    return this.lastReceived > 0 ? this.lastReceived : undefined;
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
    void this.fetchLatest(conversationId);
  }

  public loadOlder(conversationId: string): void {
    const history = this.history(conversationId);
    if (!history?.hasOlder || history.status === 'loading-older') {
      return;
    }
    void this.fetchOlder(conversationId);
  }

  /** Sends a message; it waits in the queue until the backend confirms it (RF12). */
  public send(conversationId: string, text: string, messageId = crypto.randomUUID()): void {
    this.outgoing.update((list) => [...list, { conversationId, messageId, text }]);
    this.sendNext(conversationId);
  }

  public discard(messageId: string): void {
    const message = this.outgoing().find((m) => m.messageId === messageId);
    this.inFlight.delete(messageId);
    this.sentAtPerf.delete(messageId);
    this.outgoing.update((list) => list.filter((m) => m.messageId !== messageId));
    if (message) {
      this.sendNext(message.conversationId);
    }
  }

  /** Marks an outgoing message as rejected by the backend and advances the conversation queue. */
  public failOutgoing(messageId: string, error: HubError): void {
    const message = this.outgoing().find((m) => m.messageId === messageId);
    if (!message || message.error) {
      return;
    }
    this.inFlight.delete(messageId);
    this.sentAtPerf.delete(messageId);
    this.outgoing.update((list) =>
      list.map((m) => (m.messageId === messageId ? { ...m, error } : m)),
    );
    this.sendNext(message.conversationId);
  }

  /**
   * A `message` event (architecture, section 4.2). It goes into the loaded history at the position
   * of its `sk`, once per sender and `messageId`, so every client shows the same order (RNF04).
   * The user's own message confirms the one in the queue, and the next one is sent.
   */
  public receive(message: Message): void {
    const { conversationId, sender, sentAt } = message;
    this.recordReceived([message]);
    const me = this.currentUser.user()?.username;
    const history = this.history(conversationId);
    if (history) {
      this.setHistory(conversationId, {
        ...history,
        messages: mergeMessages(history.messages, [message]),
      });
    }
    this.conversations.updateLastMessage(conversationId, sentAt, sender);
    if (sender === me) {
      const started = this.sentAtPerf.get(message.messageId);
      if (started !== undefined) {
        this.sentAtPerf.delete(message.messageId);
        this.telemetry.recordRtt(performance.now() - started, 'message');
      }
      this.inFlight.delete(message.messageId);
      this.outgoing.update((list) => list.filter((m) => m.messageId !== message.messageId));
      this.sendNext(conversationId);
    }
    if (sender === me || this.conversations.viewingId() === conversationId) {
      this.conversations.markSeen(conversationId);
    }
  }

  /** Resends the pending queue after a reconnection, one message per conversation (RF12, 4.4). */
  public resendPending(): void {
    this.inFlight.clear();
    this.sentAtPerf.clear();
    const conversationIds = new Set(
      this.outgoing()
        .filter((m) => !m.error)
        .map((m) => m.conversationId),
    );
    for (const conversationId of conversationIds) {
      this.sendNext(conversationId, true);
    }
  }

  /**
   * Fetches messages missed while disconnected for loaded conversations listed in `updated` (or
   * still pending from an interrupted catch-up), using an `after` cursor shifted back by 30 s
   * (architecture, section 4.4).
   */
  public syncAfterReconnect(conversationIds: readonly string[]): void {
    for (const conversationId of new Set([...this.pendingSync, ...conversationIds])) {
      void this.catchUp(conversationId);
    }
  }

  private async catchUp(conversationId: string): Promise<void> {
    const history = this.history(conversationId);
    if (!history || history.status === 'loading' || history.status === 'error') {
      this.pendingSync.delete(conversationId);
      return;
    }
    this.pendingSync.add(conversationId);
    try {
      if (history.messages.length === 0) {
        const page = await this.socket.request<HistoryPage>('getHistory', { conversationId });
        this.applySyncedPage(conversationId, page.messages, page.hasMore);
      } else {
        const last = history.messages.at(-1)!;
        let cursor = skBeforeInstant(Math.max(0, last.sentAt - SYNC_OVERLAP_MS));
        for (;;) {
          const page: HistoryPage = await this.socket.request<HistoryPage>('getHistory', {
            conversationId,
            after: cursor,
          });
          this.applySyncedPage(conversationId, page.messages);
          if (!page.hasMore || page.messages.length === 0) {
            break;
          }
          const nextCursor = page.messages.at(-1)!.sk;
          if (nextCursor <= cursor) {
            break;
          }
          cursor = nextCursor;
        }
      }
      this.pendingSync.delete(conversationId);
    } catch (error) {
      console.warn(`Failed to catch up history for ${conversationId}:`, error);
    }
  }

  /**
   * Records a member joining or leaving, right after the latest message the client knows: the
   * loaded ones or the conversation's `lastMessageAt`, if later (architecture, section 4.6).
   */
  public addNotice(conversationId: string, kind: MemberNotice['kind'], username: string): void {
    const lastLoaded = this.history(conversationId)?.messages.at(-1)?.sk;
    const lastMessageAt = this.conversations.get(conversationId)?.lastMessageAt;
    const fromLastMessageAt =
      lastMessageAt === undefined ? undefined : skAfterInstant(lastMessageAt);
    const afterSk = [lastLoaded, fromLastMessageAt]
      .filter((sk) => sk !== undefined)
      .reduce<string | undefined>(
        (max, sk) => (max === undefined || sk > max ? sk : max),
        undefined,
      );
    this.notices.update((list) => [
      ...list,
      { id: crypto.randomUUID(), conversationId, kind, username, afterSk },
    ]);
  }

  private async fetchLatest(conversationId: string): Promise<void> {
    const known = this.history(conversationId)?.messages ?? [];
    this.setHistory(conversationId, { status: 'loading', messages: known, hasOlder: false });
    try {
      const page = await this.socket.request<HistoryPage>('getHistory', { conversationId });
      this.recordReceived(page.messages);
      // Messages that arrived while loading are kept; the repeated ones are dropped.
      const current = this.history(conversationId)?.messages ?? [];
      this.setHistory(conversationId, {
        status: 'loaded',
        messages: mergeMessages(current, page.messages),
        hasOlder: page.hasMore,
      });
    } catch {
      const current = this.history(conversationId)?.messages ?? [];
      this.setHistory(conversationId, { status: 'error', messages: current, hasOlder: false });
    }
  }

  private async fetchOlder(conversationId: string): Promise<void> {
    const history = this.history(conversationId)!;
    const first = history.messages[0];
    this.setHistory(conversationId, { ...history, status: 'loading-older' });
    try {
      const page = await this.socket.request<HistoryPage>('getHistory', {
        conversationId,
        ...(first && { before: first.sk }),
      });
      this.recordReceived(page.messages);
      const current = this.history(conversationId)!;
      this.setHistory(conversationId, {
        status: 'loaded',
        messages: mergeMessages(current.messages, page.messages),
        hasOlder: page.hasMore,
      });
    } catch {
      const current = this.history(conversationId)!;
      this.setHistory(conversationId, { ...current, status: 'older-error' });
    }
  }

  private applySyncedPage(
    conversationId: string,
    messages: readonly Message[],
    hasOlder?: boolean,
  ): void {
    this.recordReceived(messages);
    const current = this.history(conversationId);
    if (current) {
      this.setHistory(conversationId, {
        ...current,
        messages: mergeMessages(current.messages, messages),
        hasOlder: hasOlder === undefined ? current.hasOlder : current.hasOlder || hasOlder,
      });
    }
    const me = this.currentUser.user()?.username;
    let confirmedOwn = false;
    for (const message of messages) {
      this.conversations.updateLastMessage(conversationId, message.sentAt, message.sender);
      if (message.sender === me && this.outgoing().some((m) => m.messageId === message.messageId)) {
        this.inFlight.delete(message.messageId);
        this.sentAtPerf.delete(message.messageId);
        this.outgoing.update((list) => list.filter((m) => m.messageId !== message.messageId));
        confirmedOwn = true;
      }
    }
    if (confirmedOwn) {
      this.sendNext(conversationId);
    }
    if (messages.length > 0 && this.conversations.viewingId() === conversationId) {
      this.conversations.markSeen(conversationId);
    }
  }

  private recordReceived(messages: readonly Message[]): void {
    for (const message of messages) {
      if (message.sentAt > this.lastReceived) {
        this.lastReceived = message.sentAt;
      }
    }
  }

  /**
   * Sends the first pending message of the conversation, unless it is already waiting. The others
   * wait for its confirmation, so two of them can't get the same `sentAt` and change places
   * (architecture, section 4.4).
   */
  private sendNext(conversationId: string, resend = false): void {
    if (!this.connection.connected()) {
      return;
    }
    const next = this.outgoing().find((m) => m.conversationId === conversationId && !m.error);
    if (!next || this.inFlight.has(next.messageId)) {
      return;
    }
    const { messageId, text } = next;
    if (resend) {
      console.info(`Resending message ${messageId} from the queue.`);
      this.telemetry.record('retry', `Reenvio da fila (${messageId.slice(0, 8)})`);
    }
    this.inFlight.add(messageId);
    this.sentAtPerf.set(messageId, performance.now());
    // The confirmation is the `message` event itself; the request only ends with an error or
    // without an answer in 15 s.
    this.socket
      .request('sendMessage', { conversationId, messageId, text })
      .catch((error: unknown) => {
        this.inFlight.delete(messageId);
        this.sentAtPerf.delete(messageId);
        if (!this.outgoing().some((m) => m.messageId === messageId)) {
          return; // Already confirmed or discarded.
        }
        const reason = error instanceof RequestFailure ? error.reason : 'noResponse';
        if (reason !== 'noResponse') {
          this.failOutgoing(messageId, reason);
        } else if (this.connection.connected()) {
          this.sendNext(conversationId, true);
        }
        // Without the connection, it stays pending until the client reconnects.
      });
  }

  private setHistory(conversationId: string, history: History): void {
    this.histories.update((map) => new Map(map).set(conversationId, history));
  }
}

/** Joins messages in `sk` order, once per sender and `messageId` (architecture, section 4.4). */
export function mergeMessages(
  known: readonly Message[],
  arrived: readonly Message[],
): readonly Message[] {
  const byId = new Map(known.map((m) => [`${m.sender}#${m.messageId}`, m]));
  for (const message of arrived) {
    const key = `${message.sender}#${message.messageId}`;
    if (!byId.has(key)) {
      byId.set(key, message);
    }
  }
  return byId.size === known.length ? known : [...byId.values()].sort(compareMessages);
}
