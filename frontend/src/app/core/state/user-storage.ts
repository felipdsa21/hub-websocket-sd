import { DOCUMENT, Service, inject } from '@angular/core';
import {
  isValidDisplayName,
  isValidUsername,
  normalizeDisplayName,
  normalizeUsername,
} from '@/core/model/names';

/** What the client keeps per user in the browser (architecture, section 4.6). */
interface StoredUser {
  /** Last display name used when entering or updating the profile (RF01). */
  readonly displayName?: string;
  /** `sentAt` of the last message seen in each conversation (RF10). */
  readonly seen?: Readonly<Record<string, number>>;
}

/** Browser-wide current user key, kept outside per-user records (architecture, section 4.6). */
export const CURRENT_USER_STORAGE_KEY = 'hub:current-user';

/** One key per user, by the username in lowercase (section 3.1). */
export function userStorageKey(username: string): string {
  return `hub:user:${normalizeUsername(username)}`;
}

/**
 * The browser's `localStorage`, separated by user, plus the browser's single active user. It can
 * be unavailable, as in some private windows; then nothing is kept and the client works as on a
 * first visit.
 */
@Service()
export class UserStorage {
  private readonly window = inject(DOCUMENT).defaultView;

  /** Reads the active browser user, clearing it if stored outside the username rules (4.6). */
  public readCurrentUser(): string | null {
    const raw = this.getItem(CURRENT_USER_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    if (!isValidUsername(raw)) {
      this.clearCurrentUser();
      return null;
    }
    return normalizeUsername(raw);
  }

  public writeCurrentUser(username: string): void {
    this.setItem(CURRENT_USER_STORAGE_KEY, normalizeUsername(username));
  }

  public clearCurrentUser(): void {
    this.removeItem(CURRENT_USER_STORAGE_KEY);
  }

  /** Reads the saved display name, clearing it if invalid while preserving `seen` (4.6). */
  public readDisplayName(username: string): string | undefined {
    const stored = this.read(username);
    if (stored.displayName === undefined) {
      return undefined;
    }
    if (typeof stored.displayName !== 'string' || !isValidDisplayName(stored.displayName)) {
      this.clearDisplayName(username);
      return undefined;
    }
    return normalizeDisplayName(stored.displayName);
  }

  public writeDisplayName(username: string, displayName: string): void {
    const name = normalizeDisplayName(displayName);
    if (!name || !isValidDisplayName(displayName)) {
      this.clearDisplayName(username);
      return;
    }
    const stored = this.read(username);
    this.write(username, { ...stored, displayName: name });
  }

  public clearDisplayName(username: string): void {
    const stored = this.read(username);
    if (stored.displayName === undefined) {
      return;
    }
    const next: StoredUser = stored.seen ? { seen: stored.seen } : {};
    this.write(username, next);
  }

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
      const value: unknown = JSON.parse(this.getItem(userStorageKey(username)) ?? 'null');
      return value !== null && typeof value === 'object' ? (value as StoredUser) : {};
    } catch {
      return {};
    }
  }

  private write(username: string, value: StoredUser): void {
    this.setItem(userStorageKey(username), JSON.stringify(value));
  }

  private getItem(key: string): string | null {
    try {
      return this.window?.localStorage.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private setItem(key: string, value: string): void {
    try {
      this.window?.localStorage.setItem(key, value);
    } catch {
      // Storage full or unavailable: values just aren't kept.
    }
  }

  private removeItem(key: string): void {
    try {
      this.window?.localStorage.removeItem(key);
    } catch {
      // Storage unavailable.
    }
  }
}
