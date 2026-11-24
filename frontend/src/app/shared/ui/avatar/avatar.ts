import { Component, computed, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { Presence } from '@/core/model/user';
import { initials } from '@/shared/format/display-names';

export type AvatarKind = 'person' | 'group' | 'unknown';

/** Initials for a person, an icon for a group, or a neutral icon for someone who isn't a contact. */
@Component({
  selector: 'app-avatar',
  imports: [MatIcon],
  templateUrl: './avatar.html',
  styleUrl: './avatar.scss',
  host: {
    'aria-hidden': 'true',
    '[class]': "'size-' + size() + ' ' + kind()",
    '[class.muted]': 'muted()',
  },
})
export class Avatar {
  public readonly kind = input<AvatarKind>('person');
  public readonly name = input('');
  public readonly size = input<40 | 32>(40);
  public readonly presence = input<Presence | null>(null);
  /** Grayed out, as for offline members, keeping the initials readable (WCAG AA). */
  public readonly muted = input(false);

  protected readonly initials = computed(() => initials(this.name()));
}
