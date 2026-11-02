import { Routes } from '@angular/router';
import { guestGuard, sessionGuard } from './core/state/session-guards';

export const routes: Routes = [
  {
    path: 'entrar',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login-page/login-page').then((m) => m.LoginPage),
  },
  {
    path: '',
    canActivate: [sessionGuard],
    loadComponent: () => import('./features/shell/shell-page/shell-page').then((m) => m.ShellPage),
  },
  { path: '**', redirectTo: '' },
];
