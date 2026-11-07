import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { publicConfig } from '../../../generated/public-config';
import { authInterceptor } from '../../core/auth/auth-interceptor';
import { AuthSession } from '../../core/auth/auth-session';
import { SearchClient } from './search-client';
import { initialBounds } from './search-model';

describe('anonymous public search transport', () => {
  it('bypasses session renewal, omits credentials, bounds cards and keeps cursors off markers', () => {
    const token = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthSession, useValue: { token } }
      ]
    });
    const client = TestBed.inject(SearchClient);
    const http = TestBed.inject(HttpTestingController);
    client.cards({ ...initialBounds(), maxPrice: 123456, cursor: 'opaque' }).subscribe();
    client.markers({ ...initialBounds(), maxPrice: 123456 }).subscribe();
    const cards = http.expectOne(
      (request) => request.url === `${publicConfig.apiBaseUrl}/listings/search`
    );
    const markers = http.expectOne(
      (request) => request.url === `${publicConfig.apiBaseUrl}/listings/markers`
    );
    expect(token).not.toHaveBeenCalled();
    expect(cards.request.credentials).toBe('omit');
    expect(cards.request.transferCache).toBe(false);
    expect(cards.request.params.get('limit')).toBe('20');
    expect(cards.request.params.get('maxPrice')).toBe('123456');
    expect(cards.request.params.get('cursor')).toBe('opaque');
    expect(markers.request.params.has('cursor')).toBe(false);
    expect(markers.request.params.has('limit')).toBe(false);
    cards.flush({ items: [], nextCursor: null });
    markers.flush({ items: [], capped: false, limit: 500 });
    http.verify();
  });
});
