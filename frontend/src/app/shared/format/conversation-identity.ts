import { Conversation } from '@/core/model/conversation';
import { Presence, UserState } from '@/core/model/user';
import { AvatarKind } from '@/shared/ui/avatar/avatar';
import { partnerOf, presenceOf } from './display-names';

/** How a conversation shows in the list, the header and the search. */
export interface ConversationIdentity {
  readonly title: string;
  readonly avatarKind: AvatarKind;
  readonly avatarName: string;
  readonly presence: Presence | null;
  /** "@usuario" of a direct chat's partner whose display name is repeated in the context. */
  readonly usernameTag: string;
}

export interface IdentityContext {
  readonly me: string;
  readonly users: ReadonlyMap<string, UserState>;
  readonly connected: boolean;
  /** Display names repeated in the context where the conversation shows. */
  readonly repeated: ReadonlySet<string>;
}

export function conversationIdentity(
  conversation: Conversation,
  context: IdentityContext,
): ConversationIdentity {
  if (conversation.type === 'group') {
    const name = conversation.name ?? '';
    return { title: name, avatarKind: 'group', avatarName: name, presence: null, usernameTag: '' };
  }
  const username = partnerOf(conversation, context.me);
  const partner = context.users.get(username);
  // Someone the client knows nothing about shows by username, with the neutral avatar.
  if (!partner) {
    return {
      title: `@${username}`,
      avatarKind: 'unknown',
      avatarName: '',
      presence: null,
      usernameTag: '',
    };
  }
  return {
    title: partner.displayName,
    avatarKind: 'person',
    avatarName: partner.displayName,
    presence: presenceOf(partner, context.connected),
    usernameTag: context.repeated.has(partner.displayName) ? `@${username}` : '',
  };
}
