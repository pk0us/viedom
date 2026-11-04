import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { HealthPage } from './health/health-page';

describe('foundation health page', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  async function create() {
    TestBed.configureTestingModule({
      imports: [HealthPage],
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    const fixture = TestBed.createComponent(HealthPage);
    const http = TestBed.inject(HttpTestingController);
    return { fixture, http };
  }

  it('shows typed API and database health', async () => {
    const { fixture, http } = await create();
    await vi.waitFor(() => {
      const requests = http.match(() => true);
      expect(requests).toHaveLength(2);
      for (const request of requests)
        request.flush(
          request.request.url.endsWith('/ready')
            ? { status: 'ready' }
            : { status: 'ok', service: 'viedom-api' }
        );
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('API is running.');
    expect(fixture.nativeElement.textContent).toContain('Database connection is ready.');
  });

  it('shows a useful failure and can retry', async () => {
    const { fixture, http } = await create();
    await vi.waitFor(() => {
      const requests = http.match(() => true);
      expect(requests).toHaveLength(2);
      for (const request of requests) request.flush({}, { status: 503, statusText: 'Unavailable' });
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('API is unavailable.');
    expect(fixture.nativeElement.textContent).toContain('Services are not ready.');
    fixture.nativeElement.querySelector('button').click();
    await vi.waitFor(() => {
      const requests = http.match(() => true);
      expect(requests).toHaveLength(2);
      for (const request of requests)
        request.flush(
          request.request.url.endsWith('/ready')
            ? { status: 'ready' }
            : { status: 'ok', service: 'viedom-api' }
        );
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Database connection is ready.');
  });
});
