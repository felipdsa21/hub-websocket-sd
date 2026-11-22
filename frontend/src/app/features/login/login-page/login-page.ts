import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormField, disabled, form, validate } from '@angular/forms/signals';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatError, MatFormField, MatHint, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Router } from '@angular/router';
import { Scenarios } from '@/core/fixtures/scenarios';
import { ThemeStore } from '@/core/layout/theme-store';
import {
  hasForbiddenNameChars,
  isValidDisplayName,
  isValidUsername,
  normalizeDisplayName,
} from '@/core/model/names';
import { SessionStore } from '@/core/state/session-store';
import { UserStorage } from '@/core/state/user-storage';

const USERNAME_HINT = '3 a 32 caracteres: letras sem acento, números, . _ -';
const USERNAME_SPACES = 'Sem espaços: use letras sem acento, números, . _ -';
const DISPLAY_NAME_HINT = 'Até 50 caracteres; vazio usa o nome de usuário.';
const DISPLAY_NAME_CONTROL_CHARS = 'Não use caracteres de controle no nome de exibição.';

@Component({
  selector: 'app-login-page',
  imports: [
    FormField,
    MatButton,
    MatError,
    MatFormField,
    MatHint,
    MatIcon,
    MatIconButton,
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
  private readonly storage = inject(UserStorage);
  private readonly scenarios = inject(Scenarios);
  private readonly router = inject(Router);
  protected readonly theme = inject(ThemeStore);

  protected readonly usernameHint = USERNAME_HINT;
  protected readonly displayNameHint = DISPLAY_NAME_HINT;
  protected readonly connecting = computed(() => this.session.enterStatus() === 'connecting');
  protected readonly failed = computed(() => this.session.enterStatus() === 'failed');

  private displayNameEdited = false;
  private displayNameSuggested = false;

  private readonly model = signal({ username: '', displayName: '' });
  protected readonly loginForm = form(this.model, (path) => {
    disabled(path, () => this.connecting());
    validate(path.username, ({ value }) => {
      if (/\s/.test(value())) {
        return { kind: 'spaces', message: USERNAME_SPACES };
      }
      return isValidUsername(value()) ? undefined : { kind: 'username', message: USERNAME_HINT };
    });
    validate(path.displayName, ({ value }) => {
      if (hasForbiddenNameChars(value())) {
        return { kind: 'controlChars', message: DISPLAY_NAME_CONTROL_CHARS };
      }
      return normalizeDisplayName(value()) === '' || isValidDisplayName(value())
        ? undefined
        : { kind: 'displayName', message: DISPLAY_NAME_HINT };
    });
  });

  constructor() {
    effect(() => {
      const username = this.model().username;
      untracked(() => this.proposeDisplayName(username));
    });
  }

  protected onDisplayNameInput(): void {
    this.displayNameEdited = true;
    this.displayNameSuggested = false;
  }

  /** Proposes the last saved display name for the typed username without overwriting manual edits. */
  protected proposeDisplayName(username = this.model().username): void {
    if (this.displayNameEdited || this.scenarios.any()) {
      return;
    }
    const suggested = isValidUsername(username)
      ? (this.storage.readDisplayName(username) ?? '')
      : '';
    if (suggested) {
      this.displayNameSuggested = true;
      if (this.model().displayName !== suggested) {
        this.model.update((m) => ({ ...m, displayName: suggested }));
      }
    } else if (this.displayNameSuggested) {
      this.displayNameSuggested = false;
      if (this.model().displayName !== '') {
        this.model.update((m) => ({ ...m, displayName: '' }));
      }
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.loginForm().invalid() || this.connecting()) {
      return;
    }
    const { username, displayName } = this.model();
    await this.session.enter(username, displayName);
    if (this.session.user()) {
      void this.router.navigateByUrl('/');
    }
  }
}
