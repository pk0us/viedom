import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type {
  ListingMarkersQuery,
  PublicListingCard,
  PublicListingMarker
} from '@viedom/contracts';
import { Subscription } from 'rxjs';
import { SearchClient } from './search-client';
import { validBounds } from './search-model';

@Injectable()
export class SearchState {
  private readonly client = inject(SearchClient);
  private readonly destroyRef = inject(DestroyRef);
  private requests = new Subscription();
  private pageRequest = new Subscription();
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  readonly query = signal<ListingMarkersQuery | null>(null);
  readonly cards = signal<PublicListingCard[]>([]);
  readonly markers = signal<PublicListingMarker[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly capped = signal(false);
  readonly loading = signal(false);
  readonly markersLoading = signal(false);
  readonly paging = signal(false);
  readonly cardError = signal('');
  readonly markerError = signal('');
  readonly pageError = signal('');
  readonly selectedId = signal<string | null>(null);
  readonly selectedCard = computed(() =>
    this.cards().find((card) => card.id === this.selectedId())
  );
  readonly selectedMarker = computed(() =>
    this.markers().find((marker) => marker.id === this.selectedId())
  );
  readonly mapMarkers = computed(() => {
    const selected = this.selectedCard();
    const markers = this.markers();
    return selected && !markers.some((marker) => marker.id === selected.id)
      ? [...markers, selected]
      : markers;
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.cancel());
  }

  search(query: ListingMarkersQuery, delay = 300): void {
    this.cancel();
    const generation = this.generation;
    this.query.set(query);
    this.cards.set([]);
    this.markers.set([]);
    this.nextCursor.set(null);
    this.capped.set(false);
    this.selectedId.set(null);
    this.cardError.set('');
    this.markerError.set('');
    this.pageError.set('');
    if (!validBounds(query)) {
      this.loading.set(false);
      this.markersLoading.set(false);
      return;
    }
    this.loading.set(true);
    this.markersLoading.set(true);
    this.timer = setTimeout(() => {
      this.requests.add(
        this.client.cards(query).subscribe({
          next: (response) => {
            if (generation !== this.generation) return;
            this.cards.set(response.items);
            this.nextCursor.set(response.nextCursor);
            this.loading.set(false);
          },
          error: () => {
            if (generation !== this.generation) return;
            this.loading.set(false);
            this.cardError.set('Homes could not be loaded. Try this search again.');
          }
        })
      );
      this.requests.add(
        this.client.markers(query).subscribe({
          next: (response) => {
            if (generation !== this.generation) return;
            this.markers.set(response.items);
            this.capped.set(response.capped);
            this.markersLoading.set(false);
          },
          error: () => {
            if (generation !== this.generation) return;
            this.markersLoading.set(false);
            this.markerError.set('Map prices could not be loaded. You can still browse the list.');
          }
        })
      );
    }, delay);
  }

  retry(): void {
    const query = this.query();
    if (query) this.search(query, 0);
  }

  loadMore(): void {
    const query = this.query();
    const cursor = this.nextCursor();
    if (!query || !cursor || this.paging() || this.loading()) return;
    const generation = this.generation;
    this.paging.set(true);
    this.pageError.set('');
    this.pageRequest = this.client.cards({ ...query, cursor }).subscribe({
      next: (response) => {
        if (generation !== this.generation) return;
        const existing = new Set(this.cards().map((card) => card.id));
        this.cards.update((cards) => [
          ...cards,
          ...response.items.filter((card) => !existing.has(card.id))
        ]);
        this.nextCursor.set(response.nextCursor === cursor ? null : response.nextCursor);
        this.paging.set(false);
      },
      error: () => {
        if (generation !== this.generation) return;
        this.paging.set(false);
        this.pageError.set(
          'More homes could not be loaded. Your current results are still available.'
        );
      }
    });
  }

  private cancel(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.requests.unsubscribe();
    this.requests = new Subscription();
    this.pageRequest.unsubscribe();
    this.paging.set(false);
  }
}
