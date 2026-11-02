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

/**
 * Display names shared by different users in the same context, which then show the username next
 * to them (specification, section 2).
 */
export function repeatedDisplayNames(users: Iterable<UserState>): ReadonlySet<string> {
  const usernamesByName = new Map<string, Set<string>>();
  for (const user of users) {
    const usernames = usernamesByName.get(user.displayName) ?? new Set();
    usernames.add(user.username);
    usernamesByName.set(user.displayName, usernames);
  }
  return new Set(
    [...usernamesByName].filter(([, usernames]) => usernames.size > 1).map(([name]) => name),
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
