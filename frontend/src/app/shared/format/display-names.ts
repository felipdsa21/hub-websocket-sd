import { UserState } from '@/core/model/user';

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

function firstLetter(word: string): string {
  return [...word][0] ?? '';
}
