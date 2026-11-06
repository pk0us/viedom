import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { MediaUploadResponse } from '@viedom/contracts';
import { publicConfig } from '../../generated/public-config';
import { AuthSession } from '../core/auth/auth-session';
import { authInterceptor } from '../core/auth/auth-interceptor';
import { OwnerMediaClient } from './owner-media-client';

describe('private media transport', () => {
  let identity = 0;
  const user = signal<object | null>({ id: 'owner' });

  function setup(platform = 'browser') {
    identity = 0;
    user.set({ id: 'owner' });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: platform },
        {
          provide: AuthSession,
          useValue: { user, identityVersion: () => identity, token: async () => 'private-token' }
        }
      ]
    });
    return {
      client: TestBed.inject(OwnerMediaClient),
      http: TestBed.inject(HttpTestingController)
    };
  }

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.unstubAllGlobals();
  });

  it('blocks private reads during SSR', async () => {
    const { client, http } = setup('server');
    await expect(client.gallery('listing')).rejects.toMatchObject({ status: 401 });
    http.expectNone(() => true);
  });

  it('delivers variants through bearer API requests outside transfer cache', async () => {
    const { client, http } = setup();
    const result = client.variant('listing', 'photo', 'large');
    await Promise.resolve();
    const request = http.expectOne(`${publicConfig.apiBaseUrl}/listings/listing/media/photo/large`);
    expect(request.request.headers.get('Authorization')).toBe('Bearer private-token');
    expect(request.request.transferCache).toBe(false);
    expect(request.request.responseType).toBe('blob');
    const blob = new Blob(['sanitized']);
    request.flush(blob);
    expect(await result).toBe(blob);
  });

  it('cancels component reads and rejects responses from an old account', async () => {
    const { client, http } = setup();
    const controller = new AbortController();
    const result = client.gallery('listing', controller.signal);
    const rejected = expect(result).rejects.toBeDefined();
    await Promise.resolve();
    const request = http.expectOne(`${publicConfig.apiBaseUrl}/listings/listing/media`);
    controller.abort();
    expect(request.cancelled).toBe(true);
    await rejected;
    const late = client.gallery('listing');
    const lateRejected = expect(late).rejects.toMatchObject({ status: 401 });
    await Promise.resolve();
    identity++;
    http
      .expectOne(`${publicConfig.apiBaseUrl}/listings/listing/media`)
      .flush({ listingId: 'listing', version: 1, items: [], coverMediaId: null });
    await lateRejected;
  });

  it('sends storage PUTs without bearer or cookies, reports progress and aborts', async () => {
    const { client, http } = setup();
    const xhr = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      withCredentials: true,
      timeout: 0,
      upload: { onprogress: vi.fn() },
      onload: () => {},
      onabort: () => {},
      status: 204
    };
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        constructor() {
          return xhr;
        }
      }
    );
    const reservation = {
      uploadUrl: 'https://private-storage.test/signed',
      headers: { 'Content-Type': 'image/jpeg' }
    } as MediaUploadResponse;
    const controller = new AbortController();
    const progress = vi.fn();
    const work = client.upload(
      reservation,
      new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' }),
      progress,
      controller.signal
    );
    expect(xhr.open).toHaveBeenCalledWith('PUT', reservation.uploadUrl);
    expect(xhr.setRequestHeader.mock.calls).toEqual([['Content-Type', 'image/jpeg']]);
    expect(xhr.withCredentials).toBe(false);
    xhr.upload.onprogress({ lengthComputable: true, loaded: 2, total: 4 });
    expect(progress).toHaveBeenCalledWith(50);
    xhr.onload();
    await work;
    expect(progress).toHaveBeenLastCalledWith(100);
    const abortWork = client.upload(
      reservation,
      new File(['bytes'], 'photo.jpg'),
      progress,
      controller.signal
    );
    const rejected = expect(abortWork).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    expect(xhr.abort).toHaveBeenCalled();
    xhr.onabort();
    await rejected;
    http.expectNone(() => true);
  });
});
