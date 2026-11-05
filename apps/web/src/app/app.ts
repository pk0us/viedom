import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  Injector
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Meta } from '@angular/platform-browser';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template:
    '<a class="skip-link" href="#main-content" (click)="skipToContent($event)">Skip to content</a><router-outlet />',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly meta = inject(Meta);

  constructor() {
    let initialNavigation = true;
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed()
      )
      .subscribe((event) => {
        let route = this.router.routerState.snapshot.root;
        let noindex = false;
        while (route) {
          noindex ||= route.data['noindex'] === true;
          if (!route.firstChild) break;
          route = route.firstChild;
        }
        this.meta.updateTag({
          name: 'robots',
          content: noindex ? 'noindex, nofollow' : 'index, follow'
        });
        if (!initialNavigation) {
          afterNextRender(
            () => {
              const fragment = this.router.parseUrl(event.urlAfterRedirects).fragment;
              const target = fragment
                ? this.document.getElementById(fragment)
                : this.document.querySelector<HTMLElement>('#main-content h1');
              target?.focus();
            },
            { injector: this.injector }
          );
        }
        initialNavigation = false;
      });
  }

  skipToContent(event: Event): void {
    event.preventDefault();
    this.document.getElementById('main-content')?.focus();
  }
}
