import { Component, computed, inject, input } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatListItem, MatNavList } from '@angular/material/list';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { RouterLink } from '@angular/router';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { CurrentUser } from '@/core/state/current-user';
import { UsersStore } from '@/core/state/users-store';
import { Clock } from '@/core/time/clock';
import { Avatar } from '@/shared/ui/avatar/avatar';
import { NewActivity } from '@/shared/ui/new-activity/new-activity';
import { conversationRows } from '../conversation-rows';

@Component({
  selector: 'app-conversation-list',
  imports: [
    Avatar,
    MatIcon,
    MatIconButton,
    MatListItem,
    MatNavList,
    MatProgressSpinner,
    NewActivity,
    RouterLink,
  ],
  templateUrl: './conversation-list.html',
  styleUrl: './conversation-list.scss',
  host: {
    role: 'region',
    'aria-labelledby': 'conversation-list-title',
    '[class.compact]': 'compact()',
  },
})
export class ConversationList {
  private readonly conversations = inject(ConversationsStore);
  private readonly users = inject(UsersStore);
  private readonly currentUser = inject(CurrentUser);
  private readonly clock = inject(Clock);
  protected readonly connected = inject(ConnectionStore).connected;

  public readonly selectedId = input<string | null>(null);
  /** On phones, the list is a screen of its own, with the "Novo" button instead of "+". */
  public readonly compact = input(false);

  protected readonly loading = this.conversations.loading;
  protected readonly rows = computed(() =>
    conversationRows({
      conversations: this.conversations.sorted(),
      me: this.currentUser.user()?.username ?? '',
      users: this.users.all(),
      withNewActivity: this.conversations.withNewActivity(),
      opened: this.conversations.openedIds(),
      connected: this.connected(),
      time: this.clock.context(),
    }),
  );
}
