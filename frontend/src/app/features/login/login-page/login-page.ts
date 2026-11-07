import { Component, computed, inject, signal } from '@angular/core';
import { FormField, disabled, form, validate } from '@angular/forms/signals';
import { MatButton } from '@angular/material/button';
import { MatError, MatFormField, MatHint, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Router } from '@angular/router';
import { isValidDisplayName, isValidUsername, normalizeDisplayName } from '@/core/model/names';
import { SessionStore } from '@/core/state/session-store';

const USERNAME_HINT = '3 a 32 caracteres: letras sem acento, números, . _ -';
const USERNAME_SPACES = 'Sem espaços: use letras sem acento, números, . _ -';
const DISPLAY_NAME_HINT = 'Até 50 caracteres; vazio usa o nome de usuário.';

@Component({
  selector: 'app-login-page',
  imports: [
    FormField,
    MatButton,
    MatError,
    MatFormField,
    MatHint,
    MatIcon,
    MatInput,
    MatLabel,
    MatProgressSpinner,
    MatSuffix,
  ],
  templateUrl: './login-page.html',
  styleUrl: './login-page.scss',
})
export class LoginPage {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  protected readonly usernameHint = USERNAME_HINT;
  protected readonly displayNameHint = DISPLAY_NAME_HINT;
  protected readonly connecting = computed(() => this.session.enterStatus() === 'connecting');
  protected readonly failed = computed(() => this.session.enterStatus() === 'failed');

  private readonly model = signal({ username: '', displayName: '' });
  protected readonly loginForm = form(this.model, (path) => {
    disabled(path, () => this.connecting());
    validate(path.username, ({ value }) => {
      if (/\s/.test(value())) {
        return { kind: 'spaces', message: USERNAME_SPACES };
      }
      return isValidUsername(value()) ? undefined : { kind: 'username', message: USERNAME_HINT };
    });
    validate(path.displayName, ({ value }) =>
      normalizeDisplayName(value()) === '' || isValidDisplayName(value())
        ? undefined
        : { kind: 'displayName', message: DISPLAY_NAME_HINT },
    );
  });

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.loginForm().invalid() || this.connecting()) {
      return;
    }
    const { username, displayName } = this.model();
    this.session.enter(username, displayName);
    if (this.session.user()) {
      void this.router.navigateByUrl('/');
    }
  }
}
