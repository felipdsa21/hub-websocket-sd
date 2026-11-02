import { Component, inject } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatDivider } from '@angular/material/divider';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { Router } from '@angular/router';
import { ConnectionStore } from '@/core/state/connection-store';
import { SessionStore } from '@/core/state/session-store';
import { Avatar } from '@/shared/ui/avatar/avatar';

/**
 * The user's avatar and menu. Its dot shows this tab's connection, not the presence contacts see.
 */
@Component({
  selector: 'app-account-menu',
  imports: [Avatar, MatDivider, MatIconButton, MatMenu, MatMenuItem, MatMenuTrigger],
  templateUrl: './account-menu.html',
  styleUrl: './account-menu.scss',
})
export class AccountMenu {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  protected readonly connected = inject(ConnectionStore).connected;

  protected readonly user = this.session.user;

  protected leave(): void {
    this.session.leave();
    void this.router.navigateByUrl('/entrar');
  }
}
