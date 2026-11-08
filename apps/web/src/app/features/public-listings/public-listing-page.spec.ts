import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { PublicListingDetail } from '@viedom/contracts';
import { PublicListingPage } from './public-listing-page';
import type { PublicListingResult } from '../../core/public-listing-resolver';
import { InquiriesClient } from '../inquiries-client';

const variant = {
  url: '/photo.webp',
  width: 1200,
  height: 800,
  bytes: 100,
  contentType: 'image/webp' as const
};
const home: PublicListingDetail = {
  id: 'a'.repeat(24),
  slug: 'sunny-home',
  publishedAt: '2026-11-01T12:00:00.000Z',
  locationPrecision: 'approximate',
  content: {
    title: 'Sunny home',
    description: '<script>alert("unsafe")</script>\nA welcoming home.',
    transactionType: 'rent',
    priceMinor: 85025,
    currency: 'EUR',
    property: {
      type: 'apartment',
      details: {
        areaM2: 85,
        bedrooms: 2,
        bathrooms: 1,
        floor: 3,
        yearBuilt: null,
        amenities: ['Balcony']
      },
      address: { countryCode: 'GR', city: 'Thessaloniki', neighborhood: 'Centre' },
      publicLocation: { type: 'Point', coordinates: [22.94, 40.64] }
    },
    media: {
      coverMediaId: 'second',
      items: [
        { id: 'first', variants: { large: variant, thumbnail: variant } },
        {
          id: 'second',
          variants: { large: { ...variant, url: '/cover.webp' }, thumbnail: variant }
        }
      ]
    }
  }
};

describe('public listing details', () => {
  let response: PublicListingResult;

  beforeEach(() => {
    response = { listing: home, unavailable: false };
    TestBed.configureTestingModule({
      providers: [
        { provide: InquiriesClient, useValue: { create: vi.fn() } },
        provideRouter([
          {
            path: 'listings/:id/:slug',
            component: PublicListingPage,
            runGuardsAndResolvers: 'always',
            resolve: { listing: () => response }
          }
        ])
      ]
    });
  });

  it('uses cover-first native gallery controls, handles photo failures and resets on another listing', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/listings/first/sunny-home', PublicListingPage);
    const element = harness.routeNativeElement!;
    expect(element.querySelector('img')?.getAttribute('src')).toBe('/cover.webp');
    const buttons = element.querySelectorAll<HTMLButtonElement>('.gallery-controls button');
    buttons[1]!.click();
    await harness.fixture.whenStable();
    expect(element.querySelector('img')?.getAttribute('src')).toBe('/photo.webp');
    element.querySelector('img')!.dispatchEvent(new Event('error'));
    await harness.fixture.whenStable();
    expect(element.querySelector('.main-photo')?.textContent).toContain(
      'This photo is unavailable'
    );
    expect(element.querySelector('img')).toBeNull();
    buttons[0]!.click();
    await harness.fixture.whenStable();
    expect(element.querySelector('img')?.getAttribute('src')).toBe('/cover.webp');
    response = {
      listing: { ...home, id: 'b'.repeat(24), content: { ...home.content, title: 'Another home' } },
      unavailable: false
    };
    const reused = await harness.navigateByUrl('/listings/second/another-home', PublicListingPage);
    await harness.fixture.whenStable();
    expect(reused).toBe(page);
    expect(element.querySelector('h1')?.textContent).toBe('Another home');
    expect(page.photoIndex()).toBe(0);
    expect(page.brokenPhotos().size).toBe(0);
  });

  it('escapes descriptions and renders approximate area links and a private inquiry form', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/listings/first/sunny-home', PublicListingPage);
    const element = harness.routeNativeElement!;
    expect(element.querySelector('.description')?.textContent).toContain('<script>');
    expect(element.querySelector('script')).toBeNull();
    expect(element.textContent).toContain('€850.25');
    expect(element.textContent).toContain('Approximate location');
    const mapLink = element.querySelector<HTMLAnchorElement>('.detail-section a')!;
    expect(mapLink.getAttribute('href')).toBe(
      '/search?west=22.93000&east=22.95000&south=40.63000&north=40.65000'
    );
    expect(element.querySelector('.contact-panel a')?.getAttribute('href')).toContain('#inquiry');
    expect(element.textContent).toContain('shared privately');
    expect(element.querySelector('form')).not.toBeNull();
  });

  it('clears old listing content on missing routes and retries transient errors', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/listings/first/sunny-home', PublicListingPage);
    response = { listing: null, unavailable: false };
    await harness.navigateByUrl('/listings/missing/no-home', PublicListingPage);
    expect(harness.routeNativeElement!.querySelector('h1')?.textContent?.trim()).toBe(
      'Home unavailable'
    );
    expect(harness.routeNativeElement!.textContent).not.toContain('Sunny home');
    response = { listing: null, unavailable: true };
    await harness.navigateByUrl('/listings/unavailable/no-home', PublicListingPage);
    expect(harness.routeNativeElement!.querySelector('h1')?.textContent?.trim()).toBe(
      'Listing temporarily unavailable'
    );
    response = { listing: home, unavailable: false };
    harness.routeNativeElement!.querySelector<HTMLButtonElement>('app-ui-state button')!.click();
    await vi.waitFor(() =>
      expect(harness.routeNativeElement!.querySelector('h1')?.textContent).toBe('Sunny home')
    );
  });
});
