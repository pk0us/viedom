import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { publicConfig } from '../../generated/public-config';
import { AuthSession } from '../core/auth/auth-session';
import { authInterceptor } from '../core/auth/auth-interceptor';
import { InquiriesClient } from './inquiries-client';

describe('inquiry transport', () => {
  const user = signal<object | null>(null);
  let identity = 0;
  const token = vi.fn();
  const body = {
    name: 'Visitor',
    email: 'visitor@example.test',
    message: 'Can I visit this home?'
  };

  function setup(platform = 'browser') {
    identity = 0;
    user.set(null);
    token.mockReset().mockResolvedValue('access-token');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: platform },
        { provide: AuthSession, useValue: { user, identityVersion: () => identity, token } }
      ]
    });
    return { client: TestBed.inject(InquiriesClient), http: TestBed.inject(HttpTestingController) };
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('submits guest inquiries without restoring a session, cookies or transfer caching', async () => {
    const { client, http } = setup();
    const work = client.create('listing/id', body);
    const request = http.expectOne(`${publicConfig.apiBaseUrl}/listings/listing%2Fid/inquiries`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('X-Inquiry-Request')).toBe('1');
    expect(request.request.headers.has('Authorization')).toBe(false);
    expect(request.request.withCredentials).toBe(false);
    expect(request.request.transferCache).toBe(false);
    expect(request.request.body).toEqual(body);
    request.flush({ id: 'receipt' });
    await expect(work).resolves.toEqual({ id: 'receipt' });
    expect(token).not.toHaveBeenCalled();
  });

  it('attaches an existing account token without retrying failed submissions', async () => {
    const { client, http } = setup();
    user.set({ id: 'owner' });
    const work = client.create('listing', body);
    const rejected = expect(work).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(token).toHaveBeenCalledOnce());
    const request = http.expectOne(`${publicConfig.apiBaseUrl}/listings/listing/inquiries`);
    expect(request.request.headers.get('Authorization')).toBe('Bearer access-token');
    request.flush({}, { status: 401, statusText: 'Unauthorized' });
    await rejected;
    http.expectNone(() => true);
  });

  it('never fetches inbox content on the server or when signed out', async () => {
    const { client, http } = setup('server');
    await expect(client.list()).rejects.toMatchObject({ status: 401 });
    await expect(client.create('listing', body)).rejects.toMatchObject({ status: 400 });
    http.expectNone(() => true);
  });

  it('protects private pages and status responses across account changes', async () => {
    const { client, http } = setup();
    user.set({ id: 'owner' });
    const work = client.list('next-page');
    const rejected = expect(work).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(token).toHaveBeenCalledOnce());
    const read = http.expectOne(
      (request) => request.url === `${publicConfig.apiBaseUrl}/me/inquiries`
    );
    expect(read.request.params.get('cursor')).toBe('next-page');
    expect(read.request.params.get('limit')).toBe('20');
    expect(read.request.transferCache).toBe(false);
    identity++;
    read.flush({ items: [], nextCursor: null });
    await rejected;
    const change = client.update('inquiry/id', { status: 'read' });
    await vi.waitFor(() => expect(token).toHaveBeenCalledTimes(2));
    const write = http.expectOne(`${publicConfig.apiBaseUrl}/me/inquiries/inquiry%2Fid`);
    expect(write.request.method).toBe('PATCH');
    expect(write.request.body).toEqual({ status: 'read' });
    expect(write.request.transferCache).toBe(false);
    write.flush({ id: 'inquiry/id', status: 'read' });
    await change;
  });
});
