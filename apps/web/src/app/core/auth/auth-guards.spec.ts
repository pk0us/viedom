import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { AuthSession } from './auth-session';
import { adminGuard, intendedRoute } from './auth-guards';

@Component({ template: '<p>Route destination</p>' })
class Destination {}

describe('administrator route access', () => {
  const user = signal<{ role: 'ADMIN' | 'USER' } | null>({ role: 'ADMIN' });
  let session: {
    user: typeof user;
    restore: ReturnType<typeof vi.fn>;
    reloadUser: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    user.set({ role: 'ADMIN' });
    session = {
      user,
      restore: vi.fn().mockResolvedValue(true),
      reloadUser: vi.fn().mockResolvedValue(undefined)
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'admin/listings/:id', component: Destination, canActivate: [adminGuard] },
          { path: 'owner', component: Destination },
          { path: 'auth/login', component: Destination }
        ]),
        { provide: AuthSession, useValue: session }
      ]
    });
  });

  it('refreshes server account eligibility before allowing a private review', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/admin/listings/private');
    expect(session.reloadUser).toHaveBeenCalledOnce();
    expect(TestBed.inject(Router).url).toBe('/admin/listings/private');
    session.reloadUser.mockImplementationOnce(async () => user.set({ role: 'USER' }));
    await harness.navigateByUrl('/admin/listings/another');
    expect(TestBed.inject(Router).url).toBe('/owner');
  });

  it('preserves a safe review return route when a live session cannot be restored', async () => {
    session.restore.mockResolvedValueOnce(false);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/admin/listings/private');
    expect(TestBed.inject(Router).url).toBe('/auth/login?returnUrl=%2Fadmin%2Flistings%2Fprivate');
    expect(session.reloadUser).not.toHaveBeenCalled();
    expect(intendedRoute('//outside.example/admin')).toBe('/owner');
    expect(intendedRoute('/admin/listings/private')).toBe('/admin/listings/private');
  });
});
