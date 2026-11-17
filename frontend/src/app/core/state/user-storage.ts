import { DOCUMENT, Service, inject } from '@angular/core';

/** What the client keeps per user in the browser (architecture, section 4.6). */
interface StoredUser {
  /** `sentAt` of the last message seen in each conversation (RF10). */
  readonly seen?: Readonly<Record<string, number>>;
}

/** One key per user, by the username, which is already lowercase (section 3.1). */
export function userStorageKey(username: string): string {
  return `hub:user:${username}`;
}

/**
 * The browser's `localStorage`, separated by user. It can be unavailable, as in some private
 * windows; then nothing is kept and the client works as on a first visit.
 */
@Service()
export class UserStorage {
  private readonly window = inject(DOCUMENT).defaultView;

  public readSeen(username: string): Map<string, number> {
    const seen = this.read(username).seen ?? {};
    return new Map(
      Object.entries(seen).filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
    );
  }

  /**
   * Records the last message seen in one conversation. Other tabs of the same user write to the same
   * key, so it merges into what is stored and never moves a mark back (section 4.6).
   */
  public writeSeen(username: string, conversationId: string, sentAt: number): void {
    const stored = this.read(username);
    const seen = Object.fromEntries(this.readSeen(username));
    seen[conversationId] = Math.max(seen[conversationId] ?? sentAt, sentAt);
    this.write(username, { ...stored, seen });
  }

  private read(username: string): StoredUser {
    try {
      const value: unknown = JSON.parse(
        this.window?.localStorage.getItem(userStorageKey(username)) ?? 'null',
      );
      return value !== null && typeof value === 'object' ? (value as StoredUser) : {};
    } catch {
      return {};
    }
  }

  private write(username: string, value: StoredUser): void {
    try {
      this.window?.localStorage.setItem(userStorageKey(username), JSON.stringify(value));
    } catch {
      // Storage full or unavailable: the marks just aren't kept.
    }
  }
}
