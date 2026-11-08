import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { PublicListingResult } from '../../core/public-listing-resolver';
import { AreaPipe } from '../../shared/area-pipe';
import { PricePipe } from '../../shared/price-pipe';
import { UiState } from '../../shared/ui-state/ui-state';

@Component({
  selector: 'app-public-listing-page',
  imports: [RouterLink, AreaPipe, PricePipe, UiState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './public-listing-page.html',
  styleUrl: './public-listing-page.scss'
})
export class PublicListingPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly routeData = toSignal(this.route.data, { requireSync: true });
  readonly result = computed(() => this.routeData()['listing'] as PublicListingResult);
  readonly listing = computed(() => this.result().listing);
  readonly photos = computed(() => {
    const media = this.listing()?.content.media;
    if (!media) return [];
    return [
      ...media.items.filter((photo) => photo.id === media.coverMediaId),
      ...media.items.filter((photo) => photo.id !== media.coverMediaId)
    ];
  });
  readonly photoIndex = linkedSignal({ source: this.listing, computation: () => 0 });
  readonly brokenPhotos = linkedSignal({
    source: this.listing,
    computation: () => new Set<string>()
  });
  readonly currentPhoto = computed(() => this.photos()[this.photoIndex()] ?? null);
  readonly nearbyQuery = computed(() => {
    const point = this.listing()?.content.property.publicLocation.coordinates;
    if (!point) return {};
    const [longitude, latitude] = point;
    return {
      west: Math.max(-180, longitude - 0.01).toFixed(5),
      east: Math.min(180, longitude + 0.01).toFixed(5),
      south: Math.max(-90, latitude - 0.01).toFixed(5),
      north: Math.min(90, latitude + 0.01).toFixed(5)
    };
  });

  changePhoto(offset: number): void {
    const count = this.photos().length;
    if (count) this.photoIndex.update((index) => (index + offset + count) % count);
  }

  photoFailed(id: string): void {
    this.brokenPhotos.update((ids) => new Set([...ids, id]));
  }

  retry(): void {
    void this.router.navigateByUrl(this.router.url, { onSameUrlNavigation: 'reload' });
  }
}
