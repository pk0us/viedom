import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';

@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'closeMenu()' },
  selector: 'app-public-layout',
  styleUrl: './public-layout.scss',
  templateUrl: './public-layout.html'
})
export class PublicLayout {
  readonly menuOpen = signal(false);
  private readonly menuButton = viewChild<ElementRef<HTMLButtonElement>>('menuButton');

  constructor() {
    inject(Router)
      .events.pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed()
      )
      .subscribe(() => this.menuOpen.set(false));
  }

  closeMenu() {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    this.menuButton()?.nativeElement.focus();
  }
}
