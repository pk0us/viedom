import { HttpErrorResponse } from '@angular/common/http';
import { Component, RESPONSE_INIT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, TitleStrategy, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { PublicListingDetail } from '@viedom/contracts';
import { of, throwError } from 'rxjs';
import { publicConfig } from '../../generated/public-config';
import { PublicListingsClient } from '../features/public-listings/public-listings-client';
import { publicListingResolver } from './public-listing-resolver';
import { SeoTitleStrategy } from './seo-title-strategy';
import { generateSitemap } from '../../sitemap';

@Component({ template: '<h1>Public page</h1>' })
class Page {}

const home: PublicListingDetail = {
  id: 'a'.repeat(24),
  slug: 'sunny-home',
  publishedAt: '2026-11-01T00:00:00.000Z',
  locationPrecision: 'approximate',
  content: {
    title: 'Sunny home',
    description: 'Welcome </script><script>alert(1)</script> to this home.',
    transactionType: 'rent',
    priceMinor: 85025,
    currency: 'EUR',
    property: {
      type: 'apartment',
      details: { areaM2: 85, bedrooms: 2, bathrooms: 1, floor: 3, yearBuilt: null, amenities: [] },
      address: { countryCode: 'GR', city: 'Thessaloniki', neighborhood: 'Centre' },
      publicLocation: { type: 'Point', coordinates: [22.94, 40.64] }
    },
    media: { coverMediaId: null, items: [] }
  }
};

describe('public SSR routing and metadata', () => {
  let read: ReturnType<typeof vi.fn>;
  let response: ResponseInit | null;

  function configure(server = false) {
    read = vi.fn(() => of(home));
    response = server ? {} : null;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'listings/:id/:slug',
            component: Page,
            resolve: { listing: publicListingResolver },
            runGuardsAndResolvers: 'always'
          },
          { path: 'owner', component: Page, data: { noindex: true }, title: 'Owner · Viedom' },
          { path: '', component: Page, title: 'Viedom home' }
        ]),
        { provide: PublicListingsClient, useValue: { read } },
        { provide: RESPONSE_INIT, useValue: response },
        { provide: TitleStrategy, useClass: SeoTitleStrategy }
      ]
    });
  }

  it('redirects stale browser slugs and escapes JSON-LD while retaining accurate cents', async () => {
    configure();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/listings/${home.id}/old-name?tracking=discard`);
    expect(TestBed.inject(Router).url).toBe(`/listings/${home.id}/${home.slug}`);
    expect(document.title).toContain(home.content.title);
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    expect(canonical?.href).toBe(`${publicConfig.webOrigin}/listings/${home.id}/${home.slug}`);
    const script = document.querySelector('script[data-public-listing]');
    expect(script?.textContent).not.toContain('</script>');
    const data = JSON.parse(script?.textContent ?? '{}');
    expect(data.offers.price).toBe('850.25');
    expect(data.about).not.toHaveProperty('geo');
    expect(data.about.address).not.toHaveProperty('streetAddress');
    await harness.navigateByUrl('/owner');
    expect(document.querySelector('script[data-public-listing]')).toBeNull();
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow'
    );
    expect(document.title).toBe('Owner · Viedom');
  });

  it('sets a permanent SSR redirect without trusting the supplied slug', async () => {
    configure(true);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/listings/${home.id}/stale`);
    expect(response?.status).toBe(301);
    expect(new Headers(response?.headers).get('Location')).toBe(
      `/listings/${home.id}/${home.slug}`
    );
  });

  it('returns 404/noindex for unpublished and malformed IDs and 503 for transient failure', async () => {
    configure(true);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/listings/invalid/anything');
    expect(response?.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    read.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 404 })));
    await harness.navigateByUrl(`/listings/${home.id}/missing`);
    expect(response?.status).toBe(404);
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow'
    );
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    read.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 503 })));
    await harness.navigateByUrl(`/listings/${home.id}/retry`);
    expect(response?.status).toBe(503);
    expect(document.title).toContain('temporarily unavailable');
  });
});

describe('publication-aware sitemap output', () => {
  it('consumes every bounded page and encodes URLs using the configured origin', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: home.id, slug: 'home & garden' }],
        nextCursor: 'next'
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const output = await generateSitemap('https://viedom.example', read);
    expect(read.mock.calls).toEqual([[null], ['next']]);
    expect(output).toContain('https://viedom.example/</loc>');
    expect(output).toContain(`${home.id}/home%20%26%20garden`);
    expect(output).not.toContain('owner');
  });

  it('fails instead of publishing a truncated sitemap on upstream failure or repeated cursors', async () => {
    await expect(
      generateSitemap('https://viedom.example', async () => {
        throw new Error('offline');
      })
    ).rejects.toThrow('offline');
    await expect(
      generateSitemap('https://viedom.example', async () => ({ items: [], nextCursor: 'same' }))
    ).rejects.toThrow('continuation');
  });
});
