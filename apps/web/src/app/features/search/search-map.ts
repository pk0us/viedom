import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewEncapsulation,
  afterNextRender,
  afterRenderEffect,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import type { ElementRef } from '@angular/core';
import type { PublicListingMarker, SearchBounds } from '@viedom/contracts';
import type { GeoJSONSource, Map, Marker } from 'maplibre-gl';
import type * as MapLibre from 'maplibre-gl';
import { publicConfig } from '../../../generated/public-config';

interface MapButton {
  marker: Marker;
  button: HTMLButtonElement;
  activate: () => void;
}

const sourceId = 'public-listings';

@Component({
  selector: 'app-search-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  templateUrl: './search-map.html',
  styleUrl: './search-map.scss',
  host: { class: 'search-map', '[hidden]': '!visible()' }
})
export class SearchMap {
  readonly bounds = input.required<SearchBounds>();
  readonly markers = input<PublicListingMarker[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly visible = input(true);
  readonly boundsChange = output<SearchBounds>();
  readonly selectListing = output<string>();
  readonly mapFailure = output<boolean>();
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly ready = signal(false);
  private readonly container = viewChild<ElementRef<HTMLDivElement>>('map');
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly buttons = new globalThis.Map<string, MapButton>();
  private readonly prices = new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
  private map: Map | undefined;
  private library?: typeof MapLibre;
  private attempt = 0;
  private applyingBounds = false;
  private appliedBounds = '';
  private emittedBounds = '';
  private loadTimeout?: ReturnType<typeof setTimeout>;
  private resizeObserver: ResizeObserver | undefined;
  private browserReady = false;

  constructor() {
    afterNextRender(() => {
      this.browserReady = true;
      if (this.visible()) void this.initialize();
    });
    afterRenderEffect(() => {
      const visible = this.visible();
      untracked(() => {
        if (!visible || !this.browserReady) return;
        if (!this.map && !this.failed()) void this.initialize();
        else this.resizeMap();
      });
    });
    effect(() => {
      const bounds = this.bounds();
      untracked(() => this.applyBounds(bounds));
    });
    effect(() => {
      const markers = this.markers();
      untracked(() => this.updateSource(markers));
    });
    effect(() => {
      this.selectedId();
      untracked(() => this.renderButtons());
    });
    this.destroyRef.onDestroy(() => {
      this.attempt++;
      this.dispose();
    });
  }

  async initialize(): Promise<void> {
    if (this.loading() || this.destroyRef.destroyed || !this.browserReady) return;
    const attempt = ++this.attempt;
    this.dispose();
    this.loading.set(true);
    this.failed.set(false);
    this.mapFailure.emit(false);
    this.loadTimeout = setTimeout(() => this.fail(attempt), 15_000);
    try {
      const library = await import('maplibre-gl');
      if (this.destroyRef.destroyed || attempt !== this.attempt || this.failed()) return;
      const container = this.container()?.nativeElement;
      if (!container) {
        this.fail(attempt);
        return;
      }
      this.library = library;
      library.setWorkerUrl(
        new URL(`maplibre/maplibre-gl-worker.mjs?v=${library.getVersion()}`, this.document.baseURI)
          .href
      );
      const map = (this.map = new library.Map({
        container,
        style: publicConfig.map.styleUrl,
        center: [publicConfig.map.longitude, publicConfig.map.latitude],
        zoom: publicConfig.map.zoom,
        attributionControl: false,
        renderWorldCopies: false,
        maxPitch: 0,
        maxZoom: 19
      }));
      map.addControl(new library.AttributionControl({ compact: false }));
      const canvas = map.getCanvas();
      canvas.setAttribute(
        'aria-label',
        'Approximate property locations. Use the property results list for an accessible alternative. Arrow keys pan; plus and minus zoom.'
      );
      canvas.addEventListener('webglcontextlost', () => this.fail(attempt));
      map.on('error', () => this.fail(attempt));
      map.on('load', () => {
        if (this.destroyRef.destroyed || attempt !== this.attempt || this.failed()) return;
        clearTimeout(this.loadTimeout);
        map.addSource(sourceId, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterRadius: 55,
          clusterMaxZoom: 15
        });
        map.addLayer({
          id: 'public-listing-points',
          type: 'circle',
          source: sourceId,
          paint: { 'circle-radius': 1, 'circle-opacity': 0 }
        });
        this.loading.set(false);
        this.ready.set(true);
        this.updateSource(this.markers());
      });
      map.on('sourcedata', (event) => {
        if (event.sourceId === sourceId && event.isSourceLoaded) this.renderButtons();
      });
      map.on('move', () => this.renderButtons());
      map.on('moveend', () => {
        this.renderButtons();
        if (this.applyingBounds || !this.ready()) return;
        const viewport = map.getBounds();
        const bounds = {
          west: this.coordinate(viewport.getWest()),
          south: this.coordinate(viewport.getSouth()),
          east: this.coordinate(viewport.getEast()),
          north: this.coordinate(viewport.getNorth())
        };
        const key = this.boundsKey(bounds);
        this.appliedBounds = key;
        if (key !== this.emittedBounds) {
          this.emittedBounds = key;
          this.boundsChange.emit(bounds);
        }
      });
      this.applyBounds(this.bounds());
      this.resizeObserver = new ResizeObserver(() => {
        if (this.visible() && this.map === map) this.resizeMap();
      });
      this.resizeObserver.observe(container);
    } catch {
      this.fail(attempt);
    }
  }

  zoomIn(): void {
    this.map?.zoomIn({ duration: 0 });
  }

  zoomOut(): void {
    this.map?.zoomOut({ duration: 0 });
  }

  private resizeMap(): void {
    const applying = this.applyingBounds;
    this.applyingBounds = true;
    this.map?.resize();
    this.applyingBounds = applying;
  }

  private applyBounds(bounds: SearchBounds): void {
    const key = this.boundsKey(bounds);
    if (!this.map || key === this.appliedBounds || key === this.emittedBounds) return;
    this.appliedBounds = key;
    this.emittedBounds = '';
    this.applyingBounds = true;
    this.map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north]
      ],
      { padding: 0, duration: 0 }
    );
    this.applyingBounds = false;
  }

  private updateSource(markers: PublicListingMarker[]): void {
    const source = this.source();
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: markers.map((marker) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: marker.publicLocation.coordinates },
        properties: { listingId: marker.id }
      }))
    });
    this.renderButtons();
  }

  private source(): GeoJSONSource | undefined {
    if (!this.ready()) return undefined;
    return this.map?.getSource<GeoJSONSource>(sourceId);
  }

  private renderButtons(): void {
    const map = this.map;
    const library = this.library;
    if (!map || !library || !this.source()) return;
    const visibleKeys = new Set<string>();
    const listings = new globalThis.Map(this.markers().map((marker) => [marker.id, marker]));
    for (const feature of map.querySourceFeatures(sourceId)) {
      if (feature.geometry.type !== 'Point') continue;
      const [longitude, latitude] = feature.geometry.coordinates;
      if (longitude === undefined || latitude === undefined) continue;
      const clusterId: unknown = feature.properties['cluster_id'];
      if (typeof clusterId === 'number') {
        const key = `cluster:${clusterId}`;
        if (visibleKeys.has(key)) continue;
        visibleKeys.add(key);
        const count = String(feature.properties['point_count']);
        this.upsertButton(
          key,
          [longitude, latitude],
          count,
          `${count} approximate property locations. Zoom in to explore this cluster.`,
          'cluster',
          () => void this.expandCluster(clusterId, [longitude, latitude])
        );
      } else {
        const id: unknown = feature.properties['listingId'];
        if (typeof id !== 'string' || id === this.selectedId() || visibleKeys.has(id)) continue;
        const listing = listings.get(id);
        if (!listing) continue;
        visibleKeys.add(id);
        this.listingButton(listing, false);
      }
    }
    const selectedId = this.selectedId();
    const selected = selectedId ? listings.get(selectedId) : undefined;
    if (selected) {
      visibleKeys.add(selected.id);
      this.listingButton(selected, true);
    }
    for (const [key, entry] of this.buttons) {
      if (visibleKeys.has(key)) continue;
      entry.marker.remove();
      this.buttons.delete(key);
    }
  }

  private listingButton(listing: PublicListingMarker, selected: boolean): void {
    const price = this.prices.format(listing.priceMinor / 100);
    const label = `${price}${listing.transactionType === 'rent' ? ' per month' : ''}. Approximate location. ${selected ? 'Selected property.' : 'Show property in results.'}`;
    const entry = this.upsertButton(
      listing.id,
      listing.publicLocation.coordinates,
      price,
      label,
      'price',
      () => this.selectListing.emit(listing.id)
    );
    entry.button.setAttribute('aria-pressed', String(selected));
    entry.button.classList.toggle('is-selected', selected);
    entry.marker.getElement().style.zIndex = selected ? '3' : '1';
  }

  private upsertButton(
    key: string,
    coordinates: [number, number],
    text: string,
    label: string,
    kind: 'price' | 'cluster',
    click: () => void
  ): MapButton {
    let entry = this.buttons.get(key);
    if (!entry) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = `search-map__${kind}`;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.buttons.get(key)?.activate();
      });
      const marker = new this.library!.Marker({ element: button })
        .setLngLat(coordinates)
        .addTo(this.map!);
      entry = { marker, button, activate: click };
      this.buttons.set(key, entry);
    }
    entry.activate = click;
    entry.marker.setLngLat(coordinates);
    entry.button.textContent = text;
    entry.button.setAttribute('aria-label', label);
    return entry;
  }

  private async expandCluster(clusterId: number, center: [number, number]): Promise<void> {
    const map = this.map;
    const attempt = this.attempt;
    try {
      const zoom = await this.source()?.getClusterExpansionZoom(clusterId);
      if (zoom === undefined || map !== this.map || attempt !== this.attempt) return;
      map?.jumpTo({ center, zoom: Math.min(zoom, 19) });
      map?.getCanvas().focus();
    } catch {
      return;
    }
  }

  private fail(attempt: number): void {
    if (this.destroyRef.destroyed || attempt !== this.attempt || this.failed()) return;
    clearTimeout(this.loadTimeout);
    this.loading.set(false);
    this.failed.set(true);
    this.ready.set(false);
    for (const entry of this.buttons.values()) entry.marker.remove();
    this.buttons.clear();
    this.mapFailure.emit(true);
  }

  private coordinate(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
  }

  private boundsKey(bounds: SearchBounds): string {
    return [bounds.west, bounds.south, bounds.east, bounds.north]
      .map((value) => this.coordinate(value))
      .join(',');
  }

  private dispose(): void {
    clearTimeout(this.loadTimeout);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    for (const entry of this.buttons.values()) entry.marker.remove();
    this.buttons.clear();
    this.map?.remove();
    this.map = undefined;
    this.appliedBounds = '';
    this.emittedBounds = '';
    this.ready.set(false);
  }
}
