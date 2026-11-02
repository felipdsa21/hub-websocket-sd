import { Conversation } from '@/core/model/conversation';
import { UserState } from '@/core/model/user';
import { TimeContext, conversationTimeLabel } from '@/core/time/time-format';
import { membersLabel, repeatedDisplayNames } from '@/shared/format/display-names';
import { AvatarKind, AvatarPresence } from '@/shared/ui/avatar/avatar';

export interface ConversationRow {
  readonly conversationId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly avatarKind: AvatarKind;
  readonly avatarName: string;
  readonly presence: AvatarPresence | null;
  readonly time?: string;
  readonly newActivity: boolean;
  /** Not loaded in this session, so unavailable while offline. */
  readonly dimmed: boolean;
}

export interface ConversationRowsInput {
  readonly conversations: readonly Conversation[];
  readonly me: string;
  readonly users: ReadonlyMap<string, UserState>;
  readonly withNewActivity: ReadonlySet<string>;
  readonly opened: ReadonlySet<string>;
  readonly connected: boolean;
  readonly time: TimeContext;
}

export function conversationRows(input: ConversationRowsInput): ConversationRow[] {
  const partnerOf = (c: Conversation) => c.members.find((m) => m !== input.me) ?? input.me;
  const partners = input.conversations
    .filter((c) => c.type === 'direct')
    .map((c) => input.users.get(partnerOf(c)))
    .filter((u) => u !== undefined);
  const repeated = repeatedDisplayNames(partners);

  return input.conversations.map((c) => {
    const common = {
      conversationId: c.conversationId,
      time:
        c.lastMessageAt === undefined
          ? undefined
          : conversationTimeLabel(c.lastMessageAt, input.time),
      newActivity: input.withNewActivity.has(c.conversationId),
      dimmed: !input.connected && !input.opened.has(c.conversationId),
    };
    if (c.type === 'group') {
      return {
        ...common,
        title: c.name ?? '',
        subtitle: membersLabel(c.members.length),
        avatarKind: 'group',
        avatarName: c.name ?? '',
        presence: null,
      };
    }
    const username = partnerOf(c);
    const partner = input.users.get(username);
    // While offline, the presence of others isn't shown as current (RF07).
    const presence = partner && input.connected ? (partner.online ? 'online' : 'offline') : null;
    const subtitle = [
      partner && repeated.has(partner.displayName) ? `@${username}` : '',
      presence === 'online' ? 'Online' : presence === 'offline' ? 'Offline' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      ...common,
      title: partner?.displayName ?? `@${username}`,
      subtitle,
      avatarKind: partner ? 'person' : 'unknown',
      avatarName: partner?.displayName ?? '',
      presence,
    };
  });
}
