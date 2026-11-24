import { Conversation } from '@/core/model/conversation';
import { Presence, UserState } from '@/core/model/user';

/** First letters of the first and last words, as in the design's avatars ("Marina Alves" → "MA"). */
export function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) {
    return '';
  }
  const last = words.length > 1 ? words.at(-1)! : '';
  return (firstLetter(first) + firstLetter(last)).toLocaleUpperCase('pt-BR');
}

/** Invisible characters, compatibility forms and runs of spaces don't tell names apart. */
function displayNameKey(name: string): string {
  return name
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Display names shared by different users in the same context, which then show the username next
 * to them (specification, section 2). Names that only differ as in `displayNameKey` count as shared.
 */
export function repeatedDisplayNames(users: Iterable<UserState>): ReadonlySet<string> {
  const groups = new Map<string, { usernames: Set<string>; names: Set<string> }>();
  for (const user of users) {
    const key = displayNameKey(user.displayName);
    const group = groups.get(key) ?? { usernames: new Set(), names: new Set() };
    group.usernames.add(user.username);
    group.names.add(user.displayName);
    groups.set(key, group);
  }
  return new Set(
    [...groups.values()].filter((g) => g.usernames.size > 1).flatMap((g) => [...g.names]),
  );
}

export function membersLabel(count: number): string {
  return count === 1 ? '1 membro' : `${count} membros`;
}

/** The other member of a direct chat; the user in a chat with themselves. */
export function partnerOf(conversation: Conversation, me: string): string {
  return conversation.members.find((m) => m !== me) ?? me;
}

/** Others' presence, which isn't shown as current while the connection is lost (RF07). */
export function presenceOf(user: UserState | undefined, connected: boolean): Presence | null {
  return user && connected ? (user.online ? 'online' : 'offline') : null;
}

export function presenceText(presence: Presence | null): string {
  return presence === 'online' ? 'Online' : presence === 'offline' ? 'Offline' : '';
}

/** "Nome · @usuario" when the display name is repeated in the context (specification, 2). */
export function nameWithUsername(user: UserState, repeated: ReadonlySet<string>): string {
  return repeated.has(user.displayName)
    ? `${user.displayName} · @${user.username}`
    : user.displayName;
}

/** Joins the parts of a detail line, as "@ana.lima · Online", skipping the empty ones. */
export function joinParts(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' · ');
}

function firstLetter(word: string): string {
  return [...word][0] ?? '';
}
