import { Component, computed, inject } from '@angular/core';
import { MatFabButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { Router, RouterOutlet } from '@angular/router';
import { Breakpoints } from '@/core/layout/breakpoints';
import { urlSignal } from '@/core/signals/observed-signals';
import { ConnectionStore } from '@/core/state/connection-store';
import { ConnectionBanner } from '@/shared/ui/connection-banner/connection-banner';
import { AccountMenu } from '../account-menu/account-menu';
import { ConversationList } from '../conversation-list/conversation-list';

@Component({
  selector: 'app-shell-page',
  imports: [AccountMenu, ConnectionBanner, ConversationList, MatFabButton, MatIcon, RouterOutlet],
  templateUrl: './shell-page.html',
  styleUrl: './shell-page.scss',
  host: {
    '[class.compact]': 'compact()',
    '[class.narrow-list]': '!breakpoints.wideList()',
  },
})
export class ShellPage {
  private readonly router = inject(Router);
  protected readonly breakpoints = inject(Breakpoints);
  protected readonly connected = inject(ConnectionStore).connected;

  protected readonly compact = computed(() => this.breakpoints.windowSize() === 'compact');

  private readonly url = urlSignal(this.router);

  protected readonly selectedId = computed(() => {
    const segments = this.router.parseUrl(this.url()).root.children['primary']?.segments ?? [];
    return segments[0]?.path === 'c' ? (segments[1]?.path ?? null) : null;
  });

  /** On phones, the list and the conversation are separate screens. */
  protected readonly showList = computed(() => !this.compact() || this.selectedId() === null);
  protected readonly showMain = computed(() => !this.compact() || this.selectedId() !== null);
}
