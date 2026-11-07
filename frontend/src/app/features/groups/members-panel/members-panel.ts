import { Component, computed, inject, input, output } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { Presence } from '@/core/model/user';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConversationsStore } from '@/core/state/conversations-store';
import { CurrentUser } from '@/core/state/current-user';
import { UsersStore } from '@/core/state/users-store';
import { nameWithUsername, presenceOf, repeatedDisplayNames } from '@/shared/format/display-names';
import { Avatar } from '@/shared/ui/avatar/avatar';

interface MemberRow {
  readonly username: string;
  readonly label: string;
  readonly name: string;
  readonly known: boolean;
  readonly presence: Presence | null;
}

interface MemberSection {
  readonly label: string | null;
  readonly members: readonly MemberRow[];
}

/**
 * A group's members, online first, as in the design's side sheet. While offline, presence isn't
 * shown as current (RF07), so the members go in a single list.
 */
@Component({
  selector: 'app-members-panel',
  imports: [Avatar, MatButton, MatIcon],
  templateUrl: './members-panel.html',
  styleUrl: './members-panel.scss',
})
export class MembersPanel {
  private readonly conversations = inject(ConversationsStore);
  private readonly users = inject(UsersStore);
  private readonly currentUser = inject(CurrentUser);
  protected readonly connected = inject(ConnectionStore).connected;

  public readonly conversationId = input.required<string>();
  /** Heading level of the Online/Offline sections, one under the panel's title. */
  public readonly sectionLevel = input<2 | 3>(3);
  public readonly addPeople = output();

  protected readonly sections = computed<MemberSection[]>(() => {
    const me = this.currentUser.user()?.username;
    const users = this.users.all();
    const members = this.conversations.get(this.conversationId())?.members ?? [];
    const states = members.map((m) => users.get(m)).filter((u) => u !== undefined);
    const repeated = repeatedDisplayNames(states);
    const connected = this.connected();

    const rows = members
      .map((username): MemberRow & { online: boolean } => {
        const user = users.get(username);
        const label = user ? nameWithUsername(user, repeated) : `@${username}`;
        return {
          username,
          label: username === me ? `${label} (você)` : label,
          name: user?.displayName ?? '',
          known: user !== undefined,
          presence: presenceOf(user, connected),
          online: user?.online ?? false,
        };
      })
      .sort((a, b) => compareMembers(a, b, me));

    if (!connected) {
      return [{ label: null, members: rows }];
    }
    const online = rows.filter((r) => r.online);
    const offline = rows.filter((r) => !r.online);
    return [
      { label: `Online — ${online.length}`, members: online },
      { label: `Offline — ${offline.length}`, members: offline },
    ].filter((s) => s.members.length > 0);
  });
}

/** The user first, then by name. */
function compareMembers(
  a: { username: string; label: string },
  b: { username: string; label: string },
  me: string | undefined,
): number {
  if (a.username === me || b.username === me) {
    return a.username === me ? -1 : 1;
  }
  return a.label.localeCompare(b.label, 'pt-BR');
}
