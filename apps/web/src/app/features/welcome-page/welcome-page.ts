import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  inject,
  signal
} from '@angular/core';
import { pendingUntilEvent, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { PublicListingCard } from '@viedom/contracts';
import { UiState } from '../../shared/ui-state/ui-state';
import { PricePipe } from '../../shared/price-pipe';
import { AreaPipe } from '../../shared/area-pipe';
import { publicConfig } from '../../../generated/public-config';
import { PublicListingsClient } from '../public-listings/public-listings-client';

@Component({
  imports: [RouterLink, UiState, PricePipe, AreaPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-welcome-page',
  styleUrl: './welcome-page.scss',
  templateUrl: './welcome-page.html'
})
export class WelcomePage {
  private readonly client = inject(PublicListingsClient);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  readonly city = publicConfig.city;
  readonly recent = signal<PublicListingCard[]>([]);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly brokenImages = signal(new Set<string>());

  constructor() {
    this.loadRecent();
  }

  loadRecent(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.failed.set(false);
    this.client
      .recent()
      .pipe(pendingUntilEvent(this.injector), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ items }) => {
          this.recent.set(items.slice(0, 6));
          this.loading.set(false);
        },
        error: () => {
          this.failed.set(true);
          this.loading.set(false);
        }
      });
  }

  imageFailed(id: string): void {
    this.brokenImages.update((ids) => new Set([...ids, id]));
  }
}
