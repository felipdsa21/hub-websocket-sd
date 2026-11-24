import { Routes } from '@angular/router';
import { guestGuard, sessionGuard } from './core/routing/session-guards';

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
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/shell/no-conversation/no-conversation').then((m) => m.NoConversation),
      },
      {
        path: 'c/:conversationId',
        loadComponent: () =>
          import('./features/conversation/conversation-page/conversation-page').then(
            (m) => m.ConversationPage,
          ),
      },
      {
        path: 'c/:conversationId/membros',
        loadComponent: () =>
          import('./features/groups/members-page/members-page').then((m) => m.MembersPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
