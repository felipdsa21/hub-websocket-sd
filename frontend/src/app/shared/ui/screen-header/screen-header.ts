import { Component, input } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { RouterLink } from '@angular/router';

/**
 * A screen's header: title and detail, with a back button on phones or a projected `[leading]`
 * element (such as the avatar) otherwise, and the projected actions after them.
 */
@Component({
  selector: 'app-screen-header',
  imports: [MatIcon, MatIconButton, RouterLink],
  templateUrl: './screen-header.html',
  styleUrl: './screen-header.scss',
  host: { '[class.with-back]': 'backLink() !== null' },
})
export class ScreenHeader {
  public readonly title = input.required<string>();
  public readonly detail = input('');
  public readonly backLink = input<string | readonly unknown[] | null>(null);
  public readonly backLabel = input('Voltar');
}
