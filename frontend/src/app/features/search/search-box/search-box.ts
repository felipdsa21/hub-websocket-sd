import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Router } from '@angular/router';
import { Conversation } from '@/core/model/conversation';
import { UserState } from '@/core/model/user';
import { ConnectionStore } from '@/core/state/connection-store';
import { CurrentUser } from '@/core/state/current-user';
import { SearchStore } from '@/core/state/search-store';
import { UsersStore } from '@/core/state/users-store';
import { NewConversationDialogs } from '@/features/new-conversation/new-conversation-dialogs';
import { membersLabel, repeatedDisplayNames } from '@/shared/format/display-names';
import { AvatarKind, AvatarPresence } from '@/shared/ui/avatar/avatar';
import { ResultRow } from '@/shared/ui/result-row/result-row';

interface ResultView {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly avatarKind: AvatarKind;
  readonly avatarName: string;
  readonly presence: AvatarPresence | null;
}

/** The search bar of the top bar, which opens the results; full screen on phones (RF05). */
@Component({
  selector: 'app-search-box',
  imports: [MatButton, MatIcon, MatIconButton, MatProgressSpinner, ResultRow],
  templateUrl: './search-box.html',
  styleUrl: './search-box.scss',
  host: {
    '[class.compact]': 'compact()',
    '[class.open]': 'open()',
    '(keydown.escape)': 'close()',
    '(focusout)': 'onFocusOut($event)',
  },
})
export class SearchBox {
  private readonly search = inject(SearchStore);
  private readonly users = inject(UsersStore);
  private readonly currentUser = inject(CurrentUser);
  private readonly router = inject(Router);
  private readonly newConversations = inject(NewConversationDialogs);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly connected = inject(ConnectionStore).connected;

  public readonly compact = input(false);

  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly status = this.search.status;
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  /** Display names repeated among the results show the username (specification, section 2). */
  private readonly repeated = computed(() => {
    const { conversations, people } = this.search.results();
    return repeatedDisplayNames([
      ...conversations.map((c) => this.partnerOf(c)).filter((u) => u !== undefined),
      ...people,
    ]);
  });

  protected readonly conversations = computed(() =>
    this.search.results().conversations.map((c) => this.conversationView(c)),
  );
  protected readonly people = computed(() =>
    this.search.results().people.map((u) => this.personView(u)),
  );
  protected readonly empty = computed(
    () => this.conversations().length === 0 && this.people().length === 0,
  );

  protected onInput(event: Event): void {
    const query = (event.target as HTMLInputElement).value;
    this.query.set(query);
    this.open.set(true);
    this.search.search(query);
  }

  protected clear(): void {
    this.query.set('');
    this.search.clear();
    this.input()?.nativeElement.focus();
  }

  protected retry(): void {
    this.search.retry();
  }

  protected close(): void {
    this.open.set(false);
    this.query.set('');
    this.search.clear();
  }

  protected openConversation(conversationId: string): void {
    this.close();
    void this.router.navigate(['/c', conversationId]);
  }

  protected openPerson(username: string): void {
    this.close();
    this.newConversations.openDirect(username);
  }

  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (!next || !this.host.nativeElement.contains(next)) {
      this.close();
    }
  }

  private partnerOf(conversation: Conversation): UserState | undefined {
    if (conversation.type !== 'direct') {
      return undefined;
    }
    const me = this.currentUser.user()?.username;
    return this.users.get(conversation.members.find((m) => m !== me) ?? '');
  }

  private presenceOf(user: UserState): AvatarPresence | null {
    return this.connected() ? (user.online ? 'online' : 'offline') : null;
  }

  private conversationView(conversation: Conversation): ResultView {
    if (conversation.type === 'group') {
      return {
        key: conversation.conversationId,
        title: conversation.name ?? '',
        subtitle: `Grupo · ${membersLabel(conversation.members.length)}`,
        avatarKind: 'group',
        avatarName: conversation.name ?? '',
        presence: null,
      };
    }
    const partner = this.partnerOf(conversation);
    const presence = partner ? this.presenceOf(partner) : null;
    return {
      key: conversation.conversationId,
      title: partner?.displayName ?? conversation.conversationId,
      subtitle: [
        partner && this.repeated().has(partner.displayName) ? `@${partner.username}` : '',
        'Chat privado',
        presence === 'online' ? 'Online' : presence === 'offline' ? 'Offline' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      avatarKind: partner ? 'person' : 'unknown',
      avatarName: partner?.displayName ?? '',
      presence,
    };
  }

  private personView(user: UserState): ResultView {
    const presence = this.presenceOf(user);
    return {
      key: user.username,
      title: user.displayName,
      subtitle: [
        this.repeated().has(user.displayName) ? `@${user.username}` : '',
        presence === 'online' ? 'Online' : presence === 'offline' ? 'Offline' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      avatarKind: 'person',
      avatarName: user.displayName,
      presence,
    };
  }
}
