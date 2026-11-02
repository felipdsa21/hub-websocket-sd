import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Router } from '@angular/router';
import { Conversation } from '@/core/model/conversation';
import { Presence, UserState } from '@/core/model/user';
import { ConnectionStore } from '@/core/state/connection-store';
import { CurrentUser } from '@/core/state/current-user';
import { SearchStore } from '@/core/state/search-store';
import { UsersStore } from '@/core/state/users-store';
import { NewConversationDialogs } from '@/features/new-conversation/new-conversation-dialogs';
import { conversationIdentity } from '@/shared/format/conversation-identity';
import {
  joinParts,
  membersLabel,
  partnerOf,
  presenceOf,
  presenceText,
  repeatedDisplayNames,
} from '@/shared/format/display-names';
import { AvatarKind } from '@/shared/ui/avatar/avatar';
import { ResultRow } from '@/shared/ui/result-row/result-row';

interface ResultView {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly avatarKind: AvatarKind;
  readonly avatarName: string;
  readonly presence: Presence | null;
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

  private readonly me = computed(() => this.currentUser.user()?.username ?? '');

  /** Display names repeated among the results show the username (specification, section 2). */
  private readonly repeated = computed(() => {
    const { conversations, people } = this.search.results();
    const partners = conversations
      .filter((c) => c.type === 'direct')
      .map((c) => this.users.get(partnerOf(c, this.me())))
      .filter((u) => u !== undefined);
    return repeatedDisplayNames([...partners, ...people]);
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

  private conversationView(conversation: Conversation): ResultView {
    const identity = conversationIdentity(conversation, {
      me: this.me(),
      users: this.users.all(),
      connected: this.connected(),
      repeated: this.repeated(),
    });
    return {
      ...identity,
      key: conversation.conversationId,
      subtitle:
        conversation.type === 'group'
          ? joinParts('Grupo', membersLabel(conversation.members.length))
          : joinParts(identity.usernameTag, 'Chat privado', presenceText(identity.presence)),
    };
  }

  private personView(user: UserState): ResultView {
    const presence = presenceOf(user, this.connected());
    return {
      key: user.username,
      title: user.displayName,
      subtitle: joinParts(
        this.repeated().has(user.displayName) && `@${user.username}`,
        presenceText(presence),
      ),
      avatarKind: 'person',
      avatarName: user.displayName,
      presence,
    };
  }
}
