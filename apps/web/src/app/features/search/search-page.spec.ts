import { Component, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { PublicListingCard, PublicListingMarker, SearchBounds } from '@viedom/contracts';
import { of } from 'rxjs';
import { SearchClient } from './search-client';
import { SearchMap } from './search-map';
import { SearchPage } from './search-page';

@Component({ selector: 'app-search-map', template: '<p>Map alternative</p>' })
class MapAlternative {
  readonly bounds = input.required<SearchBounds>();
  readonly markers = input<PublicListingMarker[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly visible = input(true);
  readonly boundsChange = output<SearchBounds>();
  readonly selectListing = output<string>();
  readonly mapFailure = output<boolean>();
}

const home: PublicListingCard = {
  id: 'a'.repeat(24),
  title: 'A sunny apartment',
  slug: 'sunny-apartment',
  transactionType: 'rent',
  priceMinor: 85025,
  currency: 'EUR',
  propertyType: 'apartment',
  areaM2: 85,
  bedrooms: 2,
  bathrooms: 1,
  city: 'Thessaloniki',
  neighborhood: 'Centre',
  publishedAt: '2026-11-01T12:00:00.000Z',
  publicLocation: { type: 'Point', coordinates: [22.94, 40.64] },
  locationPrecision: 'approximate',
  coverImage: {
    url: '/api/public-photo',
    width: 480,
    height: 320,
    bytes: 100,
    contentType: 'image/webp'
  }
};

describe('public search page interactions', () => {
  let client: { cards: ReturnType<typeof vi.fn>; markers: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    client = {
      cards: vi.fn(() => of({ items: [home], nextCursor: 'next-page' })),
      markers: vi.fn(() => of({ items: [home], capped: true, limit: 500 }))
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'search', component: SearchPage }]),
        { provide: SearchClient, useValue: client }
      ]
    });
    TestBed.overrideComponent(SearchPage, {
      remove: { imports: [SearchMap] },
      add: { imports: [MapAlternative] }
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  async function open() {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl(
      '/search?west=22.8&south=40.5&east=23&north=40.7',
      SearchPage
    );
    await vi.waitFor(() => expect(page.state.cards()).toHaveLength(1));
    await harness.fixture.whenStable();
    return { harness, page, element: harness.routeNativeElement! };
  }

  it('keeps keyboard focus and selected result when mobile list hides', async () => {
    const { harness, page, element } = await open();
    page.smallScreen.set(true);
    await harness.fixture.whenStable();
    const originalUrl = TestBed.inject(Router).url;
    const showCard = element.querySelector<HTMLButtonElement>('.home-card button')!;
    const toggle = element.querySelector<HTMLButtonElement>('#show-map-view')!;
    toggle.parentElement!.style.display = 'flex';
    const focus = vi.spyOn(toggle, 'focus');
    showCard.focus();
    expect(page.smallScreen()).toBe(true);
    showCard.click();
    expect(focus).toHaveBeenCalled();
    await harness.fixture.whenStable();
    expect(page.mobileView()).toBe('map');
    expect(page.state.selectedId()).toBe(home.id);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    page.mobileView.set('list');
    await harness.fixture.whenStable();
    expect(page.state.cards()).toHaveLength(1);
    expect(page.state.selectedId()).toBe(home.id);
    expect(TestBed.inject(Router).url).toBe(originalUrl);
    expect(client.cards).toHaveBeenCalledTimes(1);
  });

  it('validates native filters and restores state from query-only navigation', async () => {
    const { harness, page, element } = await open();
    const field = element.querySelector<HTMLInputElement>('#filter-maxPrice')!;
    const submit = element.querySelector<HTMLFormElement>('form.filters')!;
    field.value = '-1';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    submit.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await harness.fixture.whenStable();
    expect(page.invalidFilter()).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(client.cards).toHaveBeenCalledTimes(1);
    field.value = '999.99';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    submit.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(client.cards).toHaveBeenCalledTimes(2));
    expect(client.cards.mock.calls[1]![0]).toMatchObject({ maxPrice: 99999 });
    expect(TestBed.inject(Router).url).toContain('maxPrice=99999');
    await harness.navigateByUrl(
      '/search?west=22.8&south=40.5&east=23&north=40.7&transactionType=sale&maxPrice=123456',
      SearchPage
    );
    await vi.waitFor(() => expect(client.cards).toHaveBeenCalledTimes(3));
    expect(page.model().maxPrice).toBe('1234.56');
    expect(page.model().transactionType).toBe('sale');
    expect(page.state.cards()).toHaveLength(1);
  });
});
