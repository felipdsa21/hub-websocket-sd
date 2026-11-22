import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Scenarios } from '@/core/fixtures/scenarios';
import { SessionStore } from '@/core/state/session-store';

/**
 * Requires a user; a scenario URL enters as Marina, and otherwise a persisted browser session is
 * restored automatically before falling back to `/entrar` (RF01, section 4.6).
 */
export const sessionGuard: CanActivateFn = () => {
  const session = inject(SessionStore);
  if (!session.user()) {
    if (inject(Scenarios).any()) {
      session.enterForScenario();
    } else {
      session.restore();
    }
  }
  return session.user() ? true : inject(Router).createUrlTree(['/entrar']);
};

export const guestGuard: CanActivateFn = () => {
  const session = inject(SessionStore);
  if (!session.user() && !inject(Scenarios).any()) {
    session.restore();
  }
  return session.user() ? inject(Router).createUrlTree(['/']) : true;
};
