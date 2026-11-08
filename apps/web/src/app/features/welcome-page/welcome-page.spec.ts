import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PublicListingCard, RecentListingsResponse } from '@viedom/contracts';
import { Subject, of, throwError } from 'rxjs';
import { PublicListingsClient } from '../public-listings/public-listings-client';
import { WelcomePage } from './welcome-page';

const card: PublicListingCard = {
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
  coverImage: { url: '/photo.webp', width: 480, height: 320, bytes: 100, contentType: 'image/webp' }
};

describe('public home discovery', () => {
  let client: { recent: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = { recent: vi.fn(() => of({ items: [card] })) };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: PublicListingsClient, useValue: client }]
    });
  });

  it('links rent, buy and recent homes to meaningful destinations and handles broken photos', async () => {
    const fixture = TestBed.createComponent(WelcomePage);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const entries = element.querySelectorAll<HTMLAnchorElement>('.entry-actions a');
    expect(entries[0]!.getAttribute('href')).toBe('/search?transactionType=rent');
    expect(entries[1]!.getAttribute('href')).toBe('/search?transactionType=sale');
    expect(element.querySelector('.recent-card h3 a')?.getAttribute('href')).toBe(
      `/listings/${card.id}/${card.slug}`
    );
    expect(element.textContent).toContain('€850.25');
    element.querySelector('img')!.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    expect(element.querySelector('.photo')?.textContent).toContain('Photo unavailable');
    expect(element.querySelector('img')).toBeNull();
  });

  it('announces loading and empty outcomes without adding invented listings', async () => {
    const pending = new Subject<RecentListingsResponse>();
    client.recent.mockReturnValue(pending);
    const fixture = TestBed.createComponent(WelcomePage);
    expect(fixture.componentInstance.loading()).toBe(true);
    pending.next({ items: [] });
    pending.complete();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No homes are published yet');
    expect(fixture.nativeElement.querySelector('.recent-card')).toBeNull();
  });

  it('keeps public errors safe and lets visitors retry', async () => {
    client.recent.mockReturnValueOnce(throwError(() => new Error('private diagnostic')));
    const fixture = TestBed.createComponent(WelcomePage);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Recent homes unavailable');
    expect(fixture.nativeElement.textContent).not.toContain('private diagnostic');
    fixture.nativeElement.querySelector('app-ui-state button').click();
    await fixture.whenStable();
    expect(client.recent).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.querySelector('.recent-card h3')?.textContent).toContain(
      card.title
    );
  });
});
