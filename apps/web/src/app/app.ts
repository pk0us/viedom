import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  Injector,
  signal
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  ResolveEnd,
  ResolveStart,
  Router,
  RouterOutlet
} from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template:
    '<a class="skip-link" href="#main-content" (click)="skipToContent($event)">Skip to content</a>@if (resolving()) { <p class="route-loading" role="status">Loading listing…</p> }<router-outlet />',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  readonly resolving = signal(false);

  constructor() {
    let initialNavigation = true;
    let previousPath = '';
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof ResolveStart) this.resolving.set(true);
      if (
        event instanceof ResolveEnd ||
        event instanceof NavigationCancel ||
        event instanceof NavigationError ||
        event instanceof NavigationEnd
      )
        this.resolving.set(false);
    });
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed()
      )
      .subscribe((event) => {
        const path = event.urlAfterRedirects.split(/[?#]/)[0] ?? '';
        if (
          !initialNavigation &&
          (path !== previousPath || this.router.parseUrl(event.urlAfterRedirects).fragment)
        ) {
          afterNextRender(
            () => {
              const fragment = this.router.parseUrl(event.urlAfterRedirects).fragment;
              const target =
                (fragment ? this.document.getElementById(fragment) : null) ??
                this.document.querySelector<HTMLElement>('#main-content h1');
              target?.focus();
            },
            { injector: this.injector }
          );
        }
        initialNavigation = false;
        previousPath = path;
      });
  }

  skipToContent(event: Event): void {
    event.preventDefault();
    this.document.getElementById('main-content')?.focus();
  }
}
