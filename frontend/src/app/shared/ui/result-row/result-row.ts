import { Component, input } from '@angular/core';
import { Avatar, AvatarKind, AvatarPresence } from '../avatar/avatar';

/** A selectable row of a search result: a person or a conversation. Clicks reach the host. */
@Component({
  selector: 'app-result-row',
  imports: [Avatar],
  templateUrl: './result-row.html',
  styleUrl: './result-row.scss',
})
export class ResultRow {
  public readonly avatarKind = input<AvatarKind>('person');
  public readonly avatarName = input('');
  public readonly presence = input<AvatarPresence | null>(null);
  public readonly title = input.required<string>();
  public readonly subtitle = input('');
  public readonly selected = input(false);
  /** For toggles, as choosing people; null for plain actions. */
  public readonly pressed = input<boolean | null>(null);
}
