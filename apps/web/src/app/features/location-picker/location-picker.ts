import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild
} from '@angular/core';
import type { ElementRef } from '@angular/core';
import type { GeoPoint } from '@viedom/contracts';
import type { Map, Marker } from 'maplibre-gl';
import type * as MapLibre from 'maplibre-gl';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { publicConfig } from '../../../generated/public-config';

@Component({
  selector: 'app-location-picker',
  imports: [NzButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './location-picker.html',
  styleUrl: './location-picker.scss'
})
export class LocationPicker {
  readonly longitude = input.required<number>();
  readonly latitude = input.required<number>();
  readonly publicLocation = input<GeoPoint | null>(null);
  readonly disabled = input(false);
  readonly locationChange = output<{ longitude: number; latitude: number }>();
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly ready = signal(false);
  private readonly container = viewChild<ElementRef<HTMLDivElement>>('map');
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private map: Map | undefined;
  private privatePin: Marker | undefined;
  private approximatePin: Marker | undefined;
  private library?: typeof MapLibre;
  private attempt = 0;

  constructor() {
    afterNextRender(() => void this.initialize());
    effect(() => {
      const longitude = this.longitude();
      const latitude = this.latitude();
      const approximate = this.publicLocation();
      const disabled = this.disabled();
      if (!this.map || !this.library) return;
      if (this.valid(longitude, latitude)) this.privatePin?.setLngLat([longitude, latitude]);
      this.privatePin?.setDraggable(!disabled);
      this.approximatePin?.remove();
      this.approximatePin = undefined;
      if (approximate) {
        const element = this.document.createElement('div');
        element.className = 'approximate-location-marker';
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', 'Saved approximate public location');
        this.approximatePin = new this.library.Marker({ element })
          .setLngLat(approximate.coordinates)
          .addTo(this.map);
      }
    });
    this.destroyRef.onDestroy(() => {
      this.attempt++;
      this.dispose();
    });
  }

  private valid(longitude: number, latitude: number): boolean {
    return (
      Number.isFinite(longitude) &&
      Number.isFinite(latitude) &&
      longitude >= -180 &&
      longitude <= 180 &&
      latitude >= -90 &&
      latitude <= 90
    );
  }

  async initialize(): Promise<void> {
    if (this.loading() || this.destroyRef.destroyed) return;
    const attempt = ++this.attempt;
    this.dispose();
    this.loading.set(true);
    this.failed.set(false);
    try {
      const library = await import('maplibre-gl');
      if (this.destroyRef.destroyed || attempt !== this.attempt) return;
      const container = this.container()?.nativeElement;
      if (!container) return;
      this.library = library;
      library.setWorkerUrl(
        new URL(`maplibre/maplibre-gl-worker.mjs?v=${library.getVersion()}`, this.document.baseURI)
          .href
      );
      const point: [number, number] = this.valid(this.longitude(), this.latitude())
        ? [this.longitude(), this.latitude()]
        : [publicConfig.map.longitude, publicConfig.map.latitude];
      const map = (this.map = new library.Map({
        container,
        style: publicConfig.map.styleUrl,
        center: point,
        zoom: Math.max(publicConfig.map.zoom, 14),
        attributionControl: false,
        renderWorldCopies: false,
        maxPitch: 0
      }));
      map.addControl(new library.AttributionControl({ compact: false }));
      map.addControl(new library.NavigationControl({ showCompass: false }), 'top-right');
      map
        .getCanvas()
        .setAttribute(
          'aria-label',
          'Property location map. Use coordinate fields for keyboard location entry.'
        );
      this.privatePin = new library.Marker({ color: '#a51d2d', draggable: !this.disabled() })
        .setLngLat(point)
        .addTo(map);
      this.privatePin.getElement().setAttribute('aria-label', 'Private property location');
      this.privatePin.on('dragend', () => {
        if (this.disabled()) return;
        const point = this.privatePin?.getLngLat();
        if (point) this.choose(point.lng, point.lat);
      });
      map.on('click', (event) => {
        if (!this.disabled()) this.choose(event.lngLat.lng, event.lngLat.lat);
      });
      map.on('error', () => {
        if (this.destroyRef.destroyed || attempt !== this.attempt) return;
        this.loading.set(false);
        this.failed.set(true);
      });
      map.on('load', () => {
        if (this.destroyRef.destroyed || attempt !== this.attempt) return;
        this.loading.set(false);
        this.ready.set(true);
        const approximate = this.publicLocation();
        if (approximate) {
          const element = this.document.createElement('div');
          element.className = 'approximate-location-marker';
          element.setAttribute('role', 'img');
          element.setAttribute('aria-label', 'Saved approximate public location');
          this.approximatePin?.remove();
          this.approximatePin = new library.Marker({ element })
            .setLngLat(approximate.coordinates)
            .addTo(map);
        }
      });
    } catch {
      if (!this.destroyRef.destroyed && attempt === this.attempt) {
        this.failed.set(true);
        this.loading.set(false);
        this.dispose();
      }
    }
  }

  center(): void {
    if (this.valid(this.longitude(), this.latitude())) {
      this.map?.jumpTo({ center: [this.longitude(), this.latitude()] });
    }
  }

  private choose(longitude: number, latitude: number): void {
    if (!this.valid(longitude, latitude)) return;
    this.privatePin?.setLngLat([longitude, latitude]);
    this.locationChange.emit({ longitude, latitude });
  }

  private dispose(): void {
    this.privatePin?.remove();
    this.approximatePin?.remove();
    this.map?.remove();
    this.map = undefined;
    this.privatePin = undefined;
    this.approximatePin = undefined;
    this.ready.set(false);
  }
}
