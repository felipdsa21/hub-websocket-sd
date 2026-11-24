import { DOCUMENT, DestroyRef, Service, inject, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'hub:theme';

function parsePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * Controls the color scheme (system, light or dark), persisted in `localStorage` and synchronized
 * across tabs. Applies `.theme-light` / `.theme-dark` on `<html>` so Material 3 `light-dark()`
 * tokens switch immediately without reloading.
 */
@Service()
export class ThemeStore {
  private readonly document = inject(DOCUMENT);
  private readonly window = this.document.defaultView;

  private readonly preferenceSignal = signal<ThemePreference>(this.readStored());

  public readonly preference = this.preferenceSignal.asReadonly();

  constructor() {
    this.apply(this.preferenceSignal());

    const win = this.window;
    if (win) {
      const onStorage = (event: StorageEvent) => {
        if (event.storageArea && event.storageArea !== this.localStorageOrNull()) {
          return;
        }
        if (event.key === THEME_STORAGE_KEY || event.key === null) {
          const next = parsePreference(event.key === null ? this.readStoredRaw() : event.newValue);
          this.preferenceSignal.set(next);
          this.apply(next);
        }
      };
      win.addEventListener('storage', onStorage);
      inject(DestroyRef).onDestroy(() => win.removeEventListener('storage', onStorage));
    }
  }

  public set(preference: ThemePreference): void {
    this.preferenceSignal.set(preference);
    this.apply(preference);
    this.writeStored(preference);
  }

  private apply(preference: ThemePreference): void {
    const root = this.document.documentElement;
    root.classList.toggle('theme-dark', preference === 'dark');
    root.classList.toggle('theme-light', preference === 'light');
  }

  private readStored(): ThemePreference {
    return parsePreference(this.readStoredRaw());
  }

  private localStorageOrNull(): Storage | null {
    try {
      return this.window?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private readStoredRaw(): string | null {
    try {
      return this.localStorageOrNull()?.getItem(THEME_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private writeStored(preference: ThemePreference): void {
    try {
      const storage = this.localStorageOrNull();
      if (!storage) {
        return;
      }
      if (preference === 'system') {
        storage.removeItem(THEME_STORAGE_KEY);
      } else {
        storage.setItem(THEME_STORAGE_KEY, preference);
      }
    } catch {
      // Storage unavailable (e.g. private window): keep the choice in memory only.
    }
  }
}
