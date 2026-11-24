import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionStore } from '@/core/state/session-store';

/**
 * Requires a user; a persisted browser session is restored automatically before falling back to
 * `/entrar` (RF01, section 4.6).
 */
export const sessionGuard: CanActivateFn = () => {
  const session = inject(SessionStore);
  if (!session.user()) {
    session.restore();
  }
  return session.user() ? true : inject(Router).createUrlTree(['/entrar']);
};

export const guestGuard: CanActivateFn = () => {
  const session = inject(SessionStore);
  if (!session.user()) {
    session.restore();
  }
  return session.user() ? inject(Router).createUrlTree(['/']) : true;
};
