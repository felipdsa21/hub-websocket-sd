import {
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Router, RouterLink } from '@angular/router';
import { Breakpoints } from '@/core/layout/breakpoints';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { CurrentUser } from '@/core/state/current-user';
import { MessagesStore } from '@/core/state/messages-store';
import { UsersStore } from '@/core/state/users-store';
import { Clock } from '@/core/time/clock';
import { GroupDialogs } from '@/features/groups/group-dialogs';
import { MembersPanel } from '@/features/groups/members-panel/members-panel';
import { membersLabel, repeatedDisplayNames } from '@/shared/format/display-names';
import { Avatar, AvatarKind, AvatarPresence } from '@/shared/ui/avatar/avatar';
import { ConnectionBanner } from '@/shared/ui/connection-banner/connection-banner';
import { MessageBubble } from '../message-bubble/message-bubble';
import { MessageComposer } from '../message-composer/message-composer';
import { buildTimeline } from '../timeline';

/** How close to the bottom, in pixels, still counts as following the latest messages. */
const BOTTOM_THRESHOLD = 48;

@Component({
  selector: 'app-conversation-page',
  imports: [
    Avatar,
    ConnectionBanner,
    MatButton,
    MatIcon,
    MatIconButton,
    MatMenu,
    MatMenuItem,
    MatMenuTrigger,
    MatProgressSpinner,
    MembersPanel,
    MessageBubble,
    MessageComposer,
    RouterLink,
  ],
  templateUrl: './conversation-page.html',
  styleUrl: './conversation-page.scss',
  host: { '[class.compact]': 'compact()' },
})
export class ConversationPage {
  private readonly conversations = inject(ConversationsStore);
  private readonly messages = inject(MessagesStore);
  private readonly users = inject(UsersStore);
  private readonly currentUser = inject(CurrentUser);
  private readonly clock = inject(Clock);
  private readonly router = inject(Router);
  private readonly groupDialogs = inject(GroupDialogs);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly connected = inject(ConnectionStore).connected;
  protected readonly breakpoints = inject(Breakpoints);

  public readonly conversationId = input.required<string>();

  protected readonly compact = computed(() => this.breakpoints.windowSize() === 'compact');

  protected readonly conversation = computed(() => this.conversations.get(this.conversationId()));
  protected readonly history = computed(() => this.messages.history(this.conversationId()));

  /** On desktop, the members sit next to a group's conversation and can be hidden. */
  protected readonly membersOpen = signal(true);
  protected readonly showInlineMembers = computed(
    () =>
      this.membersOpen() &&
      this.conversation()?.type === 'group' &&
      this.breakpoints.windowSize() === 'expanded',
  );

  protected readonly header = computed(() => {
    const conversation = this.conversation();
    if (!conversation) {
      return null;
    }
    const connected = this.connected();
    const users = this.users.all();
    if (conversation.type === 'group') {
      const online = conversation.members.filter((m) => users.get(m)?.online).length;
      return {
        title: conversation.name ?? '',
        detail:
          membersLabel(conversation.members.length) + (connected ? ` · ${online} online` : ''),
        avatarKind: 'group' as AvatarKind,
        avatarName: conversation.name ?? '',
        presence: null,
      };
    }
    const me = this.currentUser.user()?.username;
    const username = conversation.members.find((m) => m !== me) ?? me ?? '';
    const partner = users.get(username);
    const presence: AvatarPresence | null =
      partner && connected ? (partner.online ? 'online' : 'offline') : null;
    const repeated = partner && repeatedDisplayNames(users.values()).has(partner.displayName);
    return {
      title: partner?.displayName ?? `@${username}`,
      detail: [
        repeated ? `@${username}` : '',
        presence === 'online' ? 'Online' : presence === 'offline' ? 'Offline' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      avatarKind: (partner ? 'person' : 'unknown') as AvatarKind,
      avatarName: partner?.displayName ?? '',
      presence,
    };
  });

  protected readonly timeline = computed(() => {
    const id = this.conversationId();
    const history = this.history();
    return buildTimeline({
      messages: history?.messages ?? [],
      outgoing: this.messages.outgoingIn(id),
      notices: this.messages.noticesIn(id),
      atStart: history !== undefined && !history.hasOlder,
      me: this.currentUser.user()?.username ?? '',
      users: this.users.all(),
      connected: this.connected(),
      time: this.clock.context(),
    });
  });

  protected readonly empty = computed(
    () => this.history()?.status === 'loaded' && !this.timeline().some((i) => i.kind === 'message'),
  );

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly olderSentinel = viewChild<ElementRef<HTMLElement>>('olderSentinel');
  private readonly timelineElement = viewChild<ElementRef<HTMLElement>>('timelineList');
  private followLatest = true;
  /** Distance from the bottom to restore after older messages are added on top. */
  private anchorFromBottom: number | null = null;

  constructor() {
    effect(() => {
      const id = this.conversationId();
      untracked(() => {
        this.followLatest = true;
        this.conversations.open(id);
        this.messages.open(id);
      });
    });

    // A conversation the user left or never had goes back to the list.
    effect(() => {
      if (!this.conversation() && !this.conversations.loading()) {
        void this.router.navigateByUrl('/');
      }
    });

    afterRenderEffect(() => {
      this.timeline();
      const element = this.scroller()?.nativeElement;
      if (!element) {
        return;
      }
      if (this.anchorFromBottom !== null) {
        element.scrollTop = element.scrollHeight - this.anchorFromBottom;
        this.anchorFromBottom = null;
      } else if (this.followLatest) {
        this.scrollToBottom(element);
      }
    });

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        this.loadOlder();
      }
    });
    afterRenderEffect(() => {
      observer.disconnect();
      const sentinel = this.olderSentinel()?.nativeElement;
      if (sentinel) {
        observer.observe(sentinel);
      }
    });
    // Sizes still change after rendering, as when the web font loads: lines wrap again and the
    // message field resizes. Following the latest messages keeps the view at the bottom.
    const resizeObserver = new ResizeObserver(() => {
      const element = this.scroller()?.nativeElement;
      if (element && this.followLatest) {
        this.scrollToBottom(element);
      }
    });
    afterRenderEffect(() => {
      resizeObserver.disconnect();
      for (const element of [this.scroller(), this.timelineElement()]) {
        if (element) {
          resizeObserver.observe(element.nativeElement);
        }
      }
    });
    this.destroyRef.onDestroy(() => {
      observer.disconnect();
      resizeObserver.disconnect();
    });
  }

  protected onScroll(): void {
    const element = this.scroller()?.nativeElement;
    if (element) {
      this.followLatest =
        element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD;
    }
  }

  protected loadOlder(): void {
    const element = this.scroller()?.nativeElement;
    // Going back in the history needs the connection (RF08).
    if (!element || !this.connected() || this.history()?.status !== 'loaded') {
      return;
    }
    this.anchorFromBottom = element.scrollHeight - element.scrollTop;
    this.messages.loadOlder(this.conversationId());
  }

  protected retryOlder(): void {
    const element = this.scroller()?.nativeElement;
    if (element && this.connected()) {
      this.anchorFromBottom = element.scrollHeight - element.scrollTop;
      this.messages.loadOlder(this.conversationId());
    }
  }

  protected retryLatest(): void {
    this.messages.loadLatest(this.conversationId());
  }

  protected toggleMembers(): void {
    switch (this.breakpoints.windowSize()) {
      case 'expanded':
        this.membersOpen.update((open) => !open);
        break;
      case 'medium':
        this.groupDialogs.openMembersSheet(this.conversationId());
        break;
      case 'compact':
        void this.router.navigate(['/c', this.conversationId(), 'membros']);
    }
  }

  protected addPeople(): void {
    this.groupDialogs.openAddPeople(this.conversationId());
  }

  protected leave(): void {
    this.groupDialogs.confirmLeave(this.conversationId());
  }

  protected discard(messageId: string): void {
    this.messages.discard(messageId);
  }

  private scrollToBottom(element: HTMLElement): void {
    element.scrollTop = element.scrollHeight;
  }
}
