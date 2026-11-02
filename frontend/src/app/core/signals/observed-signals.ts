import { BreakpointObserver } from '@angular/cdk/layout';
import { Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

// Like toSignal(), it must be called in an injection context, and it unsubscribes when that
// injector is destroyed.

export function mediaQuerySignal(observer: BreakpointObserver, query: string): Signal<boolean> {
  return toSignal(observer.observe(query).pipe(map((state) => state.matches)), {
    initialValue: observer.isMatched(query),
  });
}
