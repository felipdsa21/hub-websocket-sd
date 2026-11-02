import { BreakpointObserver } from '@angular/cdk/layout';
import { Service, computed, inject } from '@angular/core';
import { mediaQuerySignal } from '@/core/signals/observed-signals';

export type WindowSize = 'compact' | 'medium' | 'expanded';

@Service()
export class Breakpoints {
  private readonly observer = inject(BreakpointObserver);

  public readonly expanded = mediaQuerySignal(this.observer, '(min-width: 1200px)');
  public readonly medium = mediaQuerySignal(this.observer, '(min-width: 600px)');
  /** Below this width, the conversation list narrows from 340 px to 300 px. */
  public readonly wideList = mediaQuerySignal(this.observer, '(min-width: 840px)');

  public readonly windowSize = computed<WindowSize>(() =>
    this.expanded() ? 'expanded' : this.medium() ? 'medium' : 'compact',
  );
}
