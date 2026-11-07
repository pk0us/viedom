import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import type { PublicListingMarker, SearchBounds } from '@viedom/contracts';
import { SearchMap } from './search-map';

const maplibre = vi.hoisted(() => {
  class FakeMap {
    readonly handlers = new Map<string, ((event: Record<string, unknown>) => void)[]>();
    readonly canvas = document.createElement('canvas');
    readonly source = {
      setData: vi.fn(),
      getClusterExpansionZoom: vi.fn(async () => 16)
    };
    readonly addControl = vi.fn();
    readonly addSource = vi.fn();
    readonly addLayer = vi.fn();
    readonly remove = vi.fn();
    readonly resize = vi.fn(() => this.emit('moveend'));
    readonly jumpTo = vi.fn();
    readonly zoomIn = vi.fn();
    readonly zoomOut = vi.fn();
    readonly fitBounds = vi.fn(() => this.emit('moveend'));
    readonly querySourceFeatures = vi.fn(() => [] as unknown[]);
    readonly getBounds = vi.fn(() => ({
      getWest: () => 22.9,
      getSouth: () => 40.6,
      getEast: () => 23,
      getNorth: () => 40.7
    }));
    constructor(readonly options: { container: HTMLElement }) {
      options.container.append(this.canvas);
      instances.push(this);
    }
    on(event: string, handler: (value: Record<string, unknown>) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, value: Record<string, unknown> = {}): void {
      for (const handler of this.handlers.get(event) ?? []) handler(value);
    }
    getCanvas(): HTMLCanvasElement {
      return this.canvas;
    }
    getSource(): typeof this.source {
      return this.source;
    }
  }
  class FakeMarker {
    readonly setLngLat = vi.fn(() => this);
    constructor(readonly options: { element: HTMLElement }) {}
    addTo(map: FakeMap): this {
      map.options.container.append(this.options.element);
      return this;
    }
    getElement(): HTMLElement {
      return this.options.element;
    }
    remove(): void {
      this.options.element.remove();
    }
  }
  const instances: FakeMap[] = [];
  return {
    Map: FakeMap,
    Marker: FakeMarker,
    AttributionControl: class {},
    setWorkerUrl: vi.fn(),
    getVersion: () => '6.16.0',
    instances
  };
});

vi.mock('maplibre-gl', () => maplibre);

const bounds: SearchBounds = { west: 22.91, south: 40.61, east: 22.99, north: 40.69 };
const listing: PublicListingMarker = {
  id: 'a'.repeat(24),
  transactionType: 'rent',
  priceMinor: 85029,
  currency: 'EUR',
  publicLocation: { type: 'Point', coordinates: [22.95, 40.65] },
  locationPrecision: 'approximate'
};

describe('search map', () => {
  let fixture: ComponentFixture<SearchMap>;

  beforeEach(async () => {
    maplibre.instances.length = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    );
    await TestBed.configureTestingModule({ imports: [SearchMap] }).compileComponents();
    fixture = TestBed.createComponent(SearchMap);
    fixture.componentRef.setInput('bounds', bounds);
    fixture.componentRef.setInput('markers', [listing]);
  });

  afterEach(() => {
    fixture.destroy();
    vi.unstubAllGlobals();
  });

  async function initialize() {
    fixture.detectChanges();
    await vi.waitFor(() => expect(maplibre.instances).toHaveLength(1));
    const map = maplibre.instances[0]!;
    map.emit('load');
    fixture.detectChanges();
    return map;
  }

  it('clusters public points and keeps the selected price accessible inside a cluster', async () => {
    const map = await initialize();
    expect(maplibre.setWorkerUrl).toHaveBeenCalledWith(
      expect.stringContaining('maplibre/maplibre-gl-worker.mjs?v=6.16.0')
    );
    expect(map.addSource).toHaveBeenCalledWith(
      'public-listings',
      expect.objectContaining({ cluster: true })
    );
    expect(map.source.setData).toHaveBeenCalledWith({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: listing.publicLocation,
          properties: { listingId: listing.id }
        }
      ]
    });
    map.querySourceFeatures.mockReturnValue([
      {
        geometry: { type: 'Point', coordinates: [22.95, 40.65] },
        properties: { cluster_id: 7, point_count: 3 }
      }
    ]);
    fixture.componentRef.setInput('selectedId', listing.id);
    fixture.detectChanges();
    const price = fixture.nativeElement.querySelector('.search-map__price') as HTMLButtonElement;
    expect(price.textContent).toBe('€850.29');
    expect(price.getAttribute('aria-pressed')).toBe('true');
    expect(price.getAttribute('aria-label')).toContain('Approximate location. Selected property.');
    expect(fixture.nativeElement.querySelector('.search-map__cluster').textContent).toBe('3');
  });

  it('selects an unclustered price and expands a cluster through native buttons', async () => {
    const map = await initialize();
    const selected = vi.fn();
    fixture.componentInstance.selectListing.subscribe(selected);
    map.querySourceFeatures.mockReturnValue([
      {
        geometry: listing.publicLocation,
        properties: { listingId: listing.id }
      },
      {
        geometry: { type: 'Point', coordinates: [22.96, 40.66] },
        properties: { cluster_id: 8, point_count: 4 }
      }
    ]);
    map.emit('sourcedata', { sourceId: 'public-listings', isSourceLoaded: true });
    fixture.nativeElement.querySelector('.search-map__price').click();
    expect(selected).toHaveBeenCalledWith(listing.id);
    fixture.nativeElement.querySelector('.search-map__cluster').click();
    await vi.waitFor(() => expect(map.jumpTo).toHaveBeenCalled());
    expect(map.jumpTo).toHaveBeenCalledWith({ center: [22.96, 40.66], zoom: 16 });
  });

  it('emits moved bounds without fitting again when the parent accepts them', async () => {
    const map = await initialize();
    const moved = vi.fn();
    fixture.componentInstance.boundsChange.subscribe(moved);
    const initialFits = map.fitBounds.mock.calls.length;
    map.emit('moveend');
    expect(moved).toHaveBeenCalledWith({ west: 22.9, south: 40.6, east: 23, north: 40.7 });
    fixture.componentRef.setInput('bounds', moved.mock.calls[0]![0]);
    fixture.componentRef.setInput('selectedId', listing.id);
    fixture.detectChanges();
    expect(map.fitBounds).toHaveBeenCalledTimes(initialFits);
    fixture.componentRef.setInput('bounds', bounds);
    fixture.detectChanges();
    expect(map.fitBounds).toHaveBeenCalledTimes(initialFits + 1);
    expect(moved).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('bounds', moved.mock.calls[0]![0]);
    fixture.detectChanges();
    expect(map.fitBounds).toHaveBeenCalledTimes(initialFits + 2);
    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    expect(map.resize).toHaveBeenCalled();
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it('reports map failures, permits retry, and ignores events after destruction', async () => {
    const map = await initialize();
    const failed = vi.fn();
    fixture.componentInstance.mapFailure.subscribe(failed);
    map.emit('error');
    fixture.detectChanges();
    expect(failed).toHaveBeenCalledWith(true);
    expect(fixture.nativeElement.textContent).toContain('You can still browse and filter');
    const retry = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (button) => (button as HTMLButtonElement).textContent === 'Retry map'
    ) as HTMLButtonElement;
    retry.click();
    await vi.waitFor(() => expect(maplibre.instances).toHaveLength(2));
    expect(map.remove).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenLastCalledWith(false);
    const replacement = maplibre.instances[1]!;
    fixture.destroy();
    replacement.emit('load');
    expect(replacement.addSource).not.toHaveBeenCalled();
    expect(replacement.remove).toHaveBeenCalledOnce();
  });

  it('defers map initialization while the map view is hidden', async () => {
    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    await Promise.resolve();
    expect(maplibre.instances).toHaveLength(0);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(maplibre.instances).toHaveLength(1));
  });
});
