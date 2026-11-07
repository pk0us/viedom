import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import type { OwnerListingSummary, OwnerListingsResponse } from '@viedom/contracts';
import { AuthSession } from '../../core/auth/auth-session';
import { OwnerListingsClient } from '../owner-listings-client';
import { OwnerOverview } from './owner-overview';

function listing(id: string, status: OwnerListingSummary['status'] = 'draft'): OwnerListingSummary {
  return {
    id,
    propertyId: 'property',
    version: 3,
    propertyVersion: 1,
    status,
    moderationHold: false,
    submittedVersion: null,
    publishedAt: null,
    expiresAt: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    transactionType: 'rent',
    title: '<script>unsafe title</script>',
    description: '',
    priceMinor: 123456,
    currency: 'EUR'
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('owner listings dashboard', () => {
  const account = {
    id: 'owner',
    email: 'owner@example.test',
    firstName: 'Alex',
    lastName: 'Owner',
    role: 'USER' as const,
    emailVerified: true
  };
  const user = signal<typeof account | null>(account);
  let identity = 0;
  let api: {
    list: ReturnType<typeof vi.fn>;
    action: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    user.set(account);
    identity = 0;
    api = {
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      action: vi.fn()
    };
    TestBed.configureTestingModule({
      imports: [OwnerOverview],
      providers: [
        provideRouter([]),
        { provide: OwnerListingsClient, useValue: api },
        {
          provide: AuthSession,
          useValue: { user, identityVersion: () => identity, reloadUser: vi.fn() }
        }
      ]
    });
  });

  async function create() {
    const fixture = TestBed.createComponent(OwnerOverview);
    await fixture.whenStable();
    return { fixture, component: fixture.componentInstance };
  }

  it('discards late results when a newer filter request has completed', async () => {
    const { component } = await create();
    const first = deferred<OwnerListingsResponse>();
    const second = deferred<OwnerListingsResponse>();
    api.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    component.status.set('draft');
    const older = component.load(true);
    component.status.set('archived');
    const newer = component.load(true);
    second.resolve({ items: [listing('new', 'archived')], nextCursor: null });
    await newer;
    first.resolve({ items: [listing('old')], nextCursor: 'stale-cursor' });
    await older;
    expect(component.items().map((item) => item.id)).toEqual(['new']);
    expect(component.nextCursor()).toBeNull();
    expect(component.loading()).toBe(false);
  });

  it('requires reload after conflict without retrying or assuming success', async () => {
    const { component, fixture } = await create();
    const item = listing('draft');
    component.items.set([item]);
    api.action.mockRejectedValue(new HttpErrorResponse({ status: 409 }));
    component.confirm(item, 'archive');
    await component.applyAction();
    expect(api.action).toHaveBeenCalledExactlyOnceWith('draft', 'archive', 3);
    expect(component.reloadRequired()).toBe(true);
    expect(component.items()[0]?.status).toBe('draft');
    component.confirm(item, 'archive');
    await component.applyAction();
    expect(api.action).toHaveBeenCalledTimes(1);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Reload listings before continuing.');
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('€1,234.56');
    await component.load(true);
    expect(component.reloadRequired()).toBe(false);
  });

  it('clears cards on sign-out and ignores their in-flight response', async () => {
    const { component, fixture } = await create();
    const response = deferred<OwnerListingsResponse>();
    api.list.mockReturnValueOnce(response.promise);
    const work = component.load(true);
    identity++;
    user.set(null);
    await fixture.whenStable();
    response.resolve({ items: [listing('private')], nextCursor: null });
    await work;
    expect(component.items()).toEqual([]);
    expect(fixture.nativeElement.querySelector('article')).toBeNull();
  });

  it('renders rejection feedback as escaped owner-visible text', async () => {
    const { component, fixture } = await create();
    component.items.set([
      {
        ...listing('rejected', 'rejected'),
        rejectionReason: '<script>private feedback</script> Remove the address from your photos.'
      }
    ]);
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('[aria-label="Review feedback"]')?.textContent
    ).toContain('<script>private feedback</script> Remove the address from your photos.');
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
  });
});
