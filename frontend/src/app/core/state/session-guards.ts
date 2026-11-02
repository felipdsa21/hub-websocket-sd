import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Scenarios } from '@/core/fixtures/scenarios';
import { SessionStore } from './session-store';

/** Requires a user; a scenario URL enters as Marina instead of going to the entry screen. */
export const sessionGuard: CanActivateFn = () => {
  const session = inject(SessionStore);
  if (!session.user() && inject(Scenarios).any()) {
    session.enterForScenario();
  }
  return session.user() ? true : inject(Router).createUrlTree(['/entrar']);
};

export const guestGuard: CanActivateFn = () =>
  inject(SessionStore).user() ? inject(Router).createUrlTree(['/']) : true;
