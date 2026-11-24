import { BreakpointObserver } from '@angular/cdk/layout';
import { Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

// Like toSignal(), these must be called in an injection context, and they unsubscribe when that
// injector is destroyed.

export function mediaQuerySignal(observer: BreakpointObserver, query: string): Signal<boolean> {
  return toSignal(observer.observe(query).pipe(map((state) => state.matches)), {
    initialValue: observer.isMatched(query),
  });
}

/** The router URL after each completed navigation. */
export function urlSignal(router: Router): Signal<string> {
  return toSignal(
    router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => router.url),
    ),
    { initialValue: router.url },
  );
}
