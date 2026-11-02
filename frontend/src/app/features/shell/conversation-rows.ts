import { Conversation } from '@/core/model/conversation';
import { UserState } from '@/core/model/user';
import { TimeContext, conversationTimeLabel } from '@/core/time/time-format';
import { ConversationIdentity, conversationIdentity } from '@/shared/format/conversation-identity';
import {
  joinParts,
  membersLabel,
  partnerOf,
  presenceText,
  repeatedDisplayNames,
} from '@/shared/format/display-names';

export interface ConversationRow extends ConversationIdentity {
  readonly conversationId: string;
  readonly subtitle: string;
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
  // The list is one context: direct chats with the same display name show the username.
  const partners = input.conversations
    .filter((c) => c.type === 'direct')
    .map((c) => input.users.get(partnerOf(c, input.me)))
    .filter((u) => u !== undefined);
  const context = { ...input, repeated: repeatedDisplayNames(partners) };

  return input.conversations.map((c) => {
    const identity = conversationIdentity(c, context);
    return {
      ...identity,
      conversationId: c.conversationId,
      subtitle:
        c.type === 'group'
          ? membersLabel(c.members.length)
          : joinParts(identity.usernameTag, presenceText(identity.presence)),
      time:
        c.lastMessageAt === undefined
          ? undefined
          : conversationTimeLabel(c.lastMessageAt, input.time),
      newActivity: input.withNewActivity.has(c.conversationId),
      dimmed: !input.connected && !input.opened.has(c.conversationId),
    };
  });
}
