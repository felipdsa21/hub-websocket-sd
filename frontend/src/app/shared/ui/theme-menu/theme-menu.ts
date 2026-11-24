import { Component, computed, inject, viewChild } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatMenu, MatMenuItem } from '@angular/material/menu';
import { ThemePreference, ThemeStore } from '@/core/layout/theme-store';

const OPTIONS: readonly { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'Sistema', icon: 'brightness_auto' },
  { value: 'light', label: 'Claro', icon: 'light_mode' },
  { value: 'dark', label: 'Escuro', icon: 'dark_mode' },
];

/**
 * The theme choice (system, light or dark) as a menu, opened by `[matMenuTriggerFor]="ref.menu()"`
 * from a button or from another menu's item.
 */
@Component({
  selector: 'app-theme-menu',
  imports: [MatIcon, MatMenu, MatMenuItem],
  templateUrl: './theme-menu.html',
  // The menu opens in an overlay, so the element itself takes no room in its parent's layout.
  styles: ':host { display: contents; }',
})
export class ThemeMenu {
  protected readonly theme = inject(ThemeStore);
  protected readonly options = OPTIONS;

  public readonly menu = viewChild.required(MatMenu);

  /** The icon of the current choice, for the button that opens the menu. */
  public readonly icon = computed(
    () => OPTIONS.find((option) => option.value === this.theme.preference())!.icon,
  );
}
