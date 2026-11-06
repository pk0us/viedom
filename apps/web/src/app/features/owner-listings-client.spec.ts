import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthSession } from '../core/auth/auth-session';
import { publicConfig } from '../../generated/public-config';
import { OwnerListingsClient } from './owner-listings-client';

describe('private owner transport', () => {
  let identity = 0;
  const user = signal<object | null>({ id: 'owner' });

  function setup(platform = 'browser') {
    identity = 0;
    user.set({ id: 'owner' });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: platform },
        { provide: AuthSession, useValue: { user, identityVersion: () => identity } }
      ]
    });
    return {
      client: TestBed.inject(OwnerListingsClient),
      http: TestBed.inject(HttpTestingController)
    };
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('does not request private content during server rendering', async () => {
    const { client, http } = setup('server');
    await expect(client.list()).rejects.toMatchObject({ status: 401 });
    http.expectNone(() => true);
  });

  it('keeps private requests out of transfer cache and rejects late account responses', async () => {
    const { client, http } = setup();
    const work = client.list('draft', 'opaque-cursor');
    const rejected = expect(work).rejects.toMatchObject({ status: 401 });
    const request = http.expectOne(
      (request) => request.url === `${publicConfig.apiBaseUrl}/me/listings`
    );
    expect(request.request.transferCache).toBe(false);
    expect(request.request.params.get('status')).toBe('draft');
    expect(request.request.params.get('cursor')).toBe('opaque-cursor');
    identity++;
    request.flush({ items: [], nextCursor: null });
    await rejected;
  });

  it('uses private preview and versioned review routes without transfer cache', async () => {
    const { client, http } = setup();
    const preview = client.preview('abc');
    const read = http.expectOne(`${publicConfig.apiBaseUrl}/me/listings/abc/preview`);
    expect(read.request.transferCache).toBe(false);
    read.flush({ version: 3 });
    await preview;
    const review = client.action('abc', 'submit', 3);
    const write = http.expectOne(`${publicConfig.apiBaseUrl}/listings/abc/submit`);
    expect(write.request.body).toEqual({ expectedVersion: 3 });
    expect(write.request.transferCache).toBe(false);
    write.flush({ status: 'pending_review' });
    await review;
  });
});
