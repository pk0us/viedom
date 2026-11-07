import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthSession } from '../../core/auth/auth-session';
import { skipAuthRetry } from '../../core/auth/auth-interceptor';
import { publicConfig } from '../../../generated/public-config';
import { AdminListingsClient } from './admin-listings-client';

describe('administrator transport boundaries', () => {
  let identity = 0;
  const user = signal<{ id: string; role: string } | null>(null);
  function setup(platform = 'browser') {
    identity = 0;
    user.set({ id: 'admin', role: 'ADMIN' });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: platform },
        { provide: AuthSession, useValue: { user, identityVersion: () => identity } }
      ]
    });
    return {
      api: TestBed.inject(AdminListingsClient),
      http: TestBed.inject(HttpTestingController)
    };
  }
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('never requests private administrator data during SSR or for an ordinary account', async () => {
    const { api, http } = setup('server');
    await expect(api.list()).rejects.toMatchObject({ status: 403 });
    http.expectNone(() => true);
    TestBed.resetTestingModule();
    const browser = setup();
    user.set({ id: 'owner', role: 'USER' });
    await expect(browser.api.detail('private')).rejects.toMatchObject({ status: 403 });
    browser.http.expectNone(() => true);
  });

  it('keeps cursor requests private and rejects late responses after a role or account change', async () => {
    const { api, http } = setup();
    const work = api.list('opaque');
    const rejected = expect(work).rejects.toMatchObject({ status: 403 });
    const request = http.expectOne((request) => request.url.endsWith('/admin/listings/pending'));
    expect(request.request.transferCache).toBe(false);
    expect(request.request.params.get('cursor')).toBe('opaque');
    expect(request.request.params.get('limit')).toBe('20');
    user.set({ id: 'admin', role: 'USER' });
    request.flush({ items: [], nextCursor: null });
    await rejected;
  });

  it('sends a versioned trimmed decision without automatic authorization replay', async () => {
    const { api, http } = setup();
    const work = api.decide('abc', 'reject', 7, '  Correct the address in the description.  ');
    const request = http.expectOne(`${publicConfig.apiBaseUrl}/admin/listings/abc/reject`);
    expect(request.request.body).toEqual({
      expectedVersion: 7,
      reason: 'Correct the address in the description.'
    });
    expect(request.request.transferCache).toBe(false);
    expect(request.request.context.get(skipAuthRetry)).toBe(true);
    request.flush({
      id: 'abc',
      version: 8,
      status: 'rejected',
      rejectionReason: 'Correct the address in the description.'
    });
    await work;
  });

  it('cancels private reads and only uses authenticated administrator photo endpoints', async () => {
    const { api, http } = setup();
    const abort = new AbortController();
    const work = api.variant('abc', 'photo', 'large', abort.signal);
    const rejected = expect(work).rejects.toBeDefined();
    const request = http.expectOne(
      `${publicConfig.apiBaseUrl}/admin/listings/abc/media/photo/large`
    );
    expect(request.request.responseType).toBe('blob');
    expect(request.request.transferCache).toBe(false);
    abort.abort();
    expect(request.cancelled).toBe(true);
    await rejected;
  });

  it('discards photo bytes from an earlier session for the same administrator', async () => {
    const { api, http } = setup();
    const work = api.variant('abc', 'photo', 'thumbnail');
    const rejected = expect(work).rejects.toMatchObject({ status: 403 });
    const request = http.expectOne(
      `${publicConfig.apiBaseUrl}/admin/listings/abc/media/photo/thumbnail`
    );
    identity++;
    request.flush(new Blob(['previous session private photo']));
    await rejected;
  });
});
