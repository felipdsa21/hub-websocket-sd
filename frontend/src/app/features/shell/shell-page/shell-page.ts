import { Component, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { Router } from '@angular/router';
import { SessionStore } from '@/core/state/session-store';

// Placeholder until the shell with the conversation list is built.
@Component({
  selector: 'app-shell-page',
  imports: [MatButton],
  templateUrl: './shell-page.html',
})
export class ShellPage {
  protected readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  protected leave(): void {
    this.session.leave();
    void this.router.navigateByUrl('/entrar');
  }
}
