import { Service, signal } from '@angular/core';

export interface SessionUser {
  readonly username: string;
  readonly displayName: string;
}

/** The user who entered in this tab; kept apart from the session so stores can read it. */
@Service()
export class CurrentUser {
  public readonly user = signal<SessionUser | null>(null);
}
