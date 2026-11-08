import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild
} from '@angular/core';
import type { ElementRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, form } from '@angular/forms/signals';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ListingMarkersQuery, SearchBounds } from '@viedom/contracts';
import { publicConfig } from '../../../generated/public-config';
import { AreaPipe } from '../../shared/area-pipe';
import { PricePipe } from '../../shared/price-pipe';
import { UiState } from '../../shared/ui-state/ui-state';
import { SearchMap } from './search-map';
import {
  emptyFilters,
  filterDraft,
  initialBounds,
  queryParams,
  readFilters,
  readSearchUrl,
  roundBounds,
  validBounds
} from './search-model';
import { SearchState } from './search-state';

@Component({
  selector: 'app-search-page',
  imports: [FormField, RouterLink, AreaPipe, PricePipe, UiState, SearchMap],
  providers: [SearchState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search-page.html',
  styleUrl: './search-page.scss'
})
export class SearchPage {
  readonly state = inject(SearchState);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly mapToggle = viewChild<ElementRef<HTMLButtonElement>>('mapToggle');
  readonly city = publicConfig.city;
  readonly bounds = signal<SearchBounds>(initialBounds());
  readonly model = signal(emptyFilters());
  readonly fields = form(this.model);
  readonly areaModel = signal(this.areaDraft(initialBounds()));
  readonly areaFields = form(this.areaModel);
  readonly areaError = signal('');
  readonly attempted = signal(false);
  readonly filterErrors = computed(() =>
    this.attempted() ? readFilters(this.model()).errors : {}
  );
  readonly invalidFilter = computed(() => Object.values(this.filterErrors()).length > 0);
  readonly oversized = computed(() => !validBounds(this.bounds()));
  readonly mobileView = signal<'map' | 'list'>('list');
  readonly smallScreen = signal(false);
  readonly mapFailed = signal(false);
  readonly urlNotice = signal(false);
  readonly brokenImages = signal<Set<string>>(new Set());
  private activeKey = '';
  private rendered = false;

  constructor() {
    afterNextRender(() => {
      const media = this.document.defaultView?.matchMedia('(max-width: 767px)');
      if (media) {
        const update = () => this.smallScreen.set(media.matches);
        update();
        media.addEventListener('change', update);
        this.destroyRef.onDestroy(() => media.removeEventListener('change', update));
      }
      this.rendered = true;
      this.restoreUrl();
    });
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(() => {
      if (this.rendered) this.restoreUrl();
    });
    afterRenderEffect(() => {
      const id = this.state.selectedId();
      const card = this.state.selectedCard();
      if (id && card)
        this.document
          .getElementById(`home-${id}`)
          ?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    });
  }

  applyFilters(event: Event): void {
    event.preventDefault();
    this.attempted.set(true);
    const { filters, errors } = readFilters(this.model());
    const first = Object.keys(errors)[0];
    if (first) {
      this.document.getElementById(`filter-${first}`)?.focus();
      return;
    }
    this.commit({ ...this.bounds(), ...filters }, false);
  }

  clearFilters(): void {
    this.model.set(emptyFilters());
    this.attempted.set(false);
    this.commit(this.bounds(), false);
  }

  move(bounds: SearchBounds): void {
    const rounded = roundBounds(bounds);
    if (JSON.stringify(rounded) === JSON.stringify(this.bounds())) return;
    this.bounds.set(rounded);
    this.areaModel.set(this.areaDraft(rounded));
    this.areaError.set('');
    const current = this.state.query();
    const { filters } = readFilters(filterDraft(current ?? {}));
    this.commit({ ...rounded, ...filters }, true);
  }

  updateArea(event: Event): void {
    event.preventDefault();
    const raw = this.areaModel();
    const parsed = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN
      ])
    ) as unknown as SearchBounds;
    if (!validBounds(parsed)) {
      this.areaError.set(
        'Enter valid bounds up to one degree wide and high. West must be below east and south below north; crossing the date line is not supported.'
      );
      this.document.getElementById('area-west')?.focus();
      return;
    }
    this.move(parsed);
  }

  resetArea(): void {
    this.move(initialBounds());
  }

  zoomIn(): void {
    const current = this.bounds();
    const longitude = Math.max(-179.5, Math.min(179.5, (current.west + current.east) / 2));
    const latitude = Math.max(-89.5, Math.min(89.5, (current.south + current.north) / 2));
    const x = Math.min(0.4, Math.max(0.0005, Math.abs(current.east - current.west) / 4));
    const y = Math.min(0.4, Math.max(0.0005, Math.abs(current.north - current.south) / 4));
    this.move({
      west: longitude - x,
      east: longitude + x,
      south: latitude - y,
      north: latitude + y
    });
  }

  select(id: string): void {
    this.state.selectedId.set(id);
    if (this.state.selectedCard())
      this.document
        .getElementById(`home-${id}`)
        ?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
  }

  showOnMap(id: string): void {
    this.select(id);
    this.mobileView.set('map');
    if (this.smallScreen()) this.mapToggle()?.nativeElement.focus();
  }

  imageFailed(id: string): void {
    this.brokenImages.update((ids) => new Set([...ids, id]));
  }

  private restoreUrl(): void {
    const { query, repaired } = readSearchUrl(this.route.snapshot.queryParamMap);
    const key = JSON.stringify(queryParams(query));
    if (key === this.activeKey) return;
    this.activeKey = key;
    this.bounds.set({ west: query.west, south: query.south, east: query.east, north: query.north });
    this.areaModel.set(this.areaDraft(query));
    this.model.set(filterDraft(query));
    this.attempted.set(false);
    this.areaError.set('');
    this.urlNotice.set(repaired);
    this.state.search(query);
  }

  private commit(query: ListingMarkersQuery, replaceUrl: boolean): void {
    const key = JSON.stringify(queryParams(query));
    if (key === this.activeKey) return;
    this.activeKey = key;
    this.urlNotice.set(false);
    this.state.search(query);
    if (validBounds(query))
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: queryParams(query),
        replaceUrl
      });
  }

  private areaDraft(bounds: SearchBounds) {
    return {
      west: String(bounds.west),
      south: String(bounds.south),
      east: String(bounds.east),
      north: String(bounds.north)
    };
  }
}
