import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { publicConfig } from '../../../generated/public-config';
import { AuthSession } from './auth-session';
import { authInterceptor } from './auth-interceptor';
import { intendedRoute } from './auth-guards';

const response = (token: string) => ({
  accessToken: token,
  expiresIn: 600,
  csrfToken: 'csrf',
  user: {
    id: 'owner',
    email: 'owner@example.test',
    firstName: 'Alex',
    lastName: 'Owner',
    role: 'USER',
    emailVerified: false
  }
});

describe('browser session boundaries', () => {
  let http: HttpTestingController;
  let session: AuthSession;
  beforeEach(() => {
    let queue = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, operation: () => Promise<unknown>) => {
          const work = queue.then(operation);
          queue = work.then(
            () => undefined,
            () => undefined
          );
          return work;
        }
      }
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting()
      ]
    });
    http = TestBed.inject(HttpTestingController);
    session = TestBed.inject(AuthSession);
  });
  afterEach(() => {
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  async function csrf() {
    await vi.waitFor(() => {
      const request = http.expectOne(`${publicConfig.apiBaseUrl}/auth/csrf`);
      expect(request.request.withCredentials).toBe(true);
      expect(request.request.headers.get('X-CSRF-Bootstrap')).toBe('1');
      expect(request.request.transferCache).toBe(false);
      request.flush({ csrfToken: 'fresh-csrf' });
    });
    await Promise.resolve();
  }
  async function login() {
    const work = session.login({ email: 'owner@example.test', password: 'long password' });
    await csrf();
    http.expectOne(`${publicConfig.apiBaseUrl}/auth/login`).flush(response('first'));
    await work;
  }

  it('coalesces concurrent refreshes and bootstraps CSRF before rotation', async () => {
    const first = session.restore();
    const second = session.restore();
    expect(second).toBe(first);
    await csrf();
    const request = http.expectOne(`${publicConfig.apiBaseUrl}/auth/refresh`);
    expect(request.request.headers.get('X-CSRF-Token')).toBe('fresh-csrf');
    request.flush(response('access'));
    expect(await first).toBe(true);
    expect(await session.token()).toBe('access');
    expect(session.user()?.firstName).toBe('Alex');
  });

  it('fails closed after a rejected refresh without retrying', async () => {
    const work = session.restore();
    await csrf();
    http
      .expectOne(`${publicConfig.apiBaseUrl}/auth/refresh`)
      .flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(await work).toBe(false);
    expect(session.user()).toBeNull();
  });

  it('retries a protected 401 once and shares the new token across failed requests', async () => {
    await login();
    const client = TestBed.inject(HttpClient);
    const first = firstValueFrom(client.get(`${publicConfig.apiBaseUrl}/me`));
    const second = firstValueFrom(client.get(`${publicConfig.apiBaseUrl}/me`));
    await Promise.resolve();
    await vi.waitFor(() => {
      const requests = http.match(`${publicConfig.apiBaseUrl}/me`);
      expect(requests.length).toBe(2);
      for (const request of requests) {
        expect(request.request.headers.get('Authorization')).toBe('Bearer first');
        request.flush({}, { status: 401, statusText: 'Unauthorized' });
      }
    });
    await csrf();
    http.expectOne(`${publicConfig.apiBaseUrl}/auth/refresh`).flush(response('next'));
    await vi.waitFor(() => {
      const requests = http.match(`${publicConfig.apiBaseUrl}/me`);
      expect(requests.length).toBe(2);
      for (const request of requests) {
        expect(request.request.headers.get('Authorization')).toBe('Bearer next');
        request.flush({}, { status: 401, statusText: 'Unauthorized' });
      }
    });
    expect(
      (await Promise.allSettled([first, second])).every((result) => result.status === 'rejected')
    ).toBe(true);
  });

  it('never attaches credentials to another origin or similarly prefixed API path', async () => {
    await login();
    for (const url of [
      'https://outside.example.test/me',
      `${publicConfig.apiBaseUrl}-outside/me`
    ]) {
      const work = firstValueFrom(TestBed.inject(HttpClient).get(url));
      const request = http.expectOne(url);
      expect(request.request.headers.has('Authorization')).toBe(false);
      expect(request.request.withCredentials).toBe(false);
      request.flush({});
      await work;
    }
  });

  it('clears local state and reboots CSRF after successful password reset', async () => {
    await login();
    const work = session.resetPassword('one-use-token', 'new long password');
    await csrf();
    http.expectOne(`${publicConfig.apiBaseUrl}/auth/reset-password`).flush(null);
    await csrf();
    await work;
    expect(session.user()).toBeNull();
  });

  it('allows only local owner destinations', () => {
    for (const destination of [
      'https://outside.test',
      '//outside.test',
      '/owner/../auth',
      '/owner?token=secret',
      '/owner%2fprivate'
    ])
      expect(intendedRoute(destination)).toBe('/owner');
    expect(intendedRoute('/owner/drafts')).toBe('/owner/drafts');
  });

  it('keeps password reset successful when the follow-up bootstrap is unavailable', async () => {
    await login();
    const work = session.resetPassword('one-use-token', 'new long password');
    await csrf();
    http.expectOne(`${publicConfig.apiBaseUrl}/auth/reset-password`).flush(null);
    await vi.waitFor(() =>
      http
        .expectOne(`${publicConfig.apiBaseUrl}/auth/csrf`)
        .flush({}, { status: 503, statusText: 'Unavailable' })
    );
    await expect(work).resolves.toBeUndefined();
    expect(session.user()).toBeNull();
  });

  it('keeps email confirmation successful when the follow-up account read fails', async () => {
    await login();
    const work = session.confirmEmail('one-use-token');
    await csrf();
    http.expectOne(`${publicConfig.apiBaseUrl}/auth/verification/confirm`).flush(null);
    await vi.waitFor(() =>
      http
        .expectOne(`${publicConfig.apiBaseUrl}/me`)
        .flush({}, { status: 503, statusText: 'Unavailable' })
    );
    await expect(work).resolves.toBeUndefined();
    expect(session.user()).toBeNull();
  });

  it('does not replay a delayed unauthorized request under a different login', async () => {
    await login();
    const work = firstValueFrom(TestBed.inject(HttpClient).get(`${publicConfig.apiBaseUrl}/me`));
    const result = Promise.allSettled([work]);
    await Promise.resolve();
    const delayed = await vi.waitFor(() => http.expectOne(`${publicConfig.apiBaseUrl}/me`));
    const nextLogin = session.login({ email: 'other@example.test', password: 'another password' });
    await csrf();
    http.expectOne(`${publicConfig.apiBaseUrl}/auth/login`).flush(response('other-account'));
    await nextLogin;
    delayed.flush({}, { status: 401, statusText: 'Unauthorized' });
    expect((await result)[0]?.status).toBe('rejected');
    expect(await session.token()).toBe('other-account');
    http.expectNone(`${publicConfig.apiBaseUrl}/auth/refresh`);
  });

  it('does not clear a newer login when a delayed retry fails', async () => {
    await login();
    const work = firstValueFrom(TestBed.inject(HttpClient).get(`${publicConfig.apiBaseUrl}/me`));
    const result = Promise.allSettled([work]);
    await Promise.resolve();
    const original = await vi.waitFor(() => http.expectOne(`${publicConfig.apiBaseUrl}/me`));
    original.flush({}, { status: 401, statusText: 'Unauthorized' });
    await csrf();
    http.expectOne(`${publicConfig.apiBaseUrl}/auth/refresh`).flush(response('renewed'));
    let delayed: ReturnType<HttpTestingController['expectOne']> | undefined;
    await vi.waitFor(() => {
      delayed = http.expectOne(`${publicConfig.apiBaseUrl}/me`);
    });
    const nextLogin = session.login({ email: 'other@example.test', password: 'another password' });
    await csrf();
    http.expectOne(`${publicConfig.apiBaseUrl}/auth/login`).flush(response('other-account'));
    await nextLogin;
    delayed!.flush({}, { status: 401, statusText: 'Unauthorized' });
    expect((await result)[0]?.status).toBe('rejected');
    expect(await session.token()).toBe('other-account');
  });
});

describe('server session isolation', () => {
  it('does not bootstrap, rotate or read a browser session during SSR', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: 'server' }
      ]
    });
    const session = TestBed.inject(AuthSession);
    expect(await session.restore()).toBe(false);
    expect(session.user()).toBeNull();
    TestBed.inject(HttpTestingController).expectNone(() => true);
  });
});
