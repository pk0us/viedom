import { HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PLATFORM_ID, TransferState, makeStateKey } from '@angular/core';
import { API_BASE_URL } from '../../health/health-client';
import { PublicListingsClient } from './public-listings-client';
import { authInterceptor } from '../../core/auth/auth-interceptor';
import { AuthSession } from '../../core/auth/auth-session';

describe('public listing transport', () => {
  it('does not renew a private session for anonymous recent or detail requests', () => {
    const token = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthSession, useValue: { token } }
      ]
    });
    const client = TestBed.inject(PublicListingsClient);
    const http = TestBed.inject(HttpTestingController);
    client.recent().subscribe();
    client.read('a'.repeat(24)).subscribe();
    const requests = http.match(() => true);
    expect(requests).toHaveLength(2);
    expect(token).not.toHaveBeenCalled();
    for (const request of requests) {
      expect(request.request.headers.has('Authorization')).toBe(false);
      expect(request.request.credentials).toBe('omit');
      request.flush(request.request.url.endsWith('/recent') ? { items: [] } : {});
    }
    http.verify();
  });

  it('uses the injected server origin and omits credentials and transfer caching', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'http://internal-api/api/' }
      ]
    });
    const client = TestBed.inject(PublicListingsClient);
    const http = TestBed.inject(HttpTestingController);
    client.recent().subscribe();
    client.read('a'.repeat(24)).subscribe();
    const recent = http.expectOne('http://internal-api/api/listings/recent');
    const detail = http.expectOne(`http://internal-api/api/listings/${'a'.repeat(24)}`);
    for (const request of [recent, detail]) {
      expect(request.request.credentials).toBe('omit');
      expect(request.request.transferCache).toBe(false);
      expect(request.request.timeout).toBe(10000);
    }
    recent.flush({ items: [] });
    detail.flush({});
    http.verify();
  });

  it('consumes a public snapshot once and fetches current discovery data on later visits', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    const state = TestBed.inject(TransferState);
    const key = makeStateKey<{ value: { items: [] } }>('viedom:public-listings:recent');
    state.set(key, { value: { items: [] } });
    const client = TestBed.inject(PublicListingsClient);
    const http = TestBed.inject(HttpTestingController);
    const received = vi.fn();
    client.recent().subscribe(received);
    expect(received).toHaveBeenCalledWith({ items: [] });
    expect(state.hasKey(key)).toBe(false);
    http.expectNone(() => true);
    client.recent().subscribe();
    http.expectOne((request) => request.url.endsWith('/listings/recent')).flush({ items: [] });
    http.verify();
  });

  it('consumes a listing snapshot once and preserves safe missing-listing status', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    const state = TestBed.inject(TransferState);
    const id = 'a'.repeat(24);
    const key = makeStateKey<{ status: 404 }>(`viedom:public-listings:${id}`);
    state.set(key, { status: 404 });
    const failed = vi.fn();
    TestBed.inject(PublicListingsClient).read(id).subscribe({ error: failed });
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(state.hasKey(key)).toBe(false);
    TestBed.inject(HttpTestingController).expectNone(() => true);
  });

  it('transfers only a safe error status from failed server requests', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: 'server' }
      ]
    });
    const state = TestBed.inject(TransferState);
    const errorHandler = vi.fn();
    TestBed.inject(PublicListingsClient).recent().subscribe({ error: errorHandler });
    TestBed.inject(HttpTestingController)
      .expectOne((request) => request.url.endsWith('/listings/recent'))
      .flush(
        { diagnostic: 'private diagnostic' },
        { status: 500, statusText: 'Internal Server Error' }
      );
    expect(errorHandler.mock.calls[0]![0]).toBeInstanceOf(HttpErrorResponse);
    expect(state.get(makeStateKey('viedom:public-listings:recent'), null)).toEqual({ status: 503 });
    expect(state.toJson()).not.toContain('private diagnostic');
  });
});
