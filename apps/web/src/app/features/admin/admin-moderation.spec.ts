import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { AdminDecisionResponse, AdminListingDetail, CurrentUser } from '@viedom/contracts';
import { AuthSession } from '../../core/auth/auth-session';
import { AdminListingsClient } from './admin-listings-client';
import { AdminModeration } from './admin-moderation';

function detail(id = 'listing'): AdminListingDetail {
  return {
    listing: {
      id,
      propertyId: 'property',
      version: 7,
      propertyVersion: 1,
      status: 'pending_review',
      moderationHold: false,
      submittedVersion: 7,
      publishedAt: null,
      expiresAt: null,
      createdAt: '2026-11-06T00:00:00Z',
      updatedAt: '2026-11-06T00:00:00Z',
      transactionType: 'rent',
      title: '<script>private title</script>',
      description: 'Description',
      priceMinor: 123456,
      currency: 'EUR',
      property: {
        id: 'property',
        version: 1,
        type: 'apartment',
        details: {
          areaM2: 70,
          bedrooms: 2,
          bathrooms: 1,
          floor: 1,
          yearBuilt: null,
          amenities: []
        },
        address: {
          countryCode: 'GR',
          city: 'Thessaloniki',
          neighborhood: 'Centre',
          street: 'Private street'
        },
        privateLocation: { type: 'Point', coordinates: [22.95, 40.63] },
        publicLocation: { type: 'Point', coordinates: [22.951, 40.631] },
        createdAt: '2026-11-06T00:00:00Z',
        updatedAt: '2026-11-06T00:00:00Z'
      },
      submission: { canSubmit: false, missing: ['state'] }
    },
    publisher: {
      id: 'owner',
      email: 'owner@example.test',
      firstName: 'Alex',
      lastName: 'Owner',
      emailVerified: true,
      active: true
    },
    media: { listingId: id, version: 7, coverMediaId: null, items: [] },
    canDecide: true,
    canApprove: true,
    history: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('administrator moderation state', () => {
  const admin: CurrentUser = {
    id: 'admin',
    email: 'admin@example.test',
    firstName: 'Admin',
    lastName: 'Reviewer',
    role: 'ADMIN',
    emailVerified: true
  };
  const user = signal<CurrentUser | null>(admin);
  let identity = 0;
  let api: {
    list: ReturnType<typeof vi.fn>;
    detail: ReturnType<typeof vi.fn>;
    decide: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    user.set(admin);
    identity = 0;
    api = {
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      detail: vi.fn().mockResolvedValue(detail()),
      decide: vi.fn()
    };
    TestBed.configureTestingModule({
      imports: [AdminModeration],
      providers: [
        provideRouter([]),
        { provide: AuthSession, useValue: { user, identityVersion: () => identity } },
        { provide: AdminListingsClient, useValue: api }
      ]
    });
  });
  async function create() {
    const fixture = TestBed.createComponent(AdminModeration);
    await fixture.whenStable();
    return { fixture, component: fixture.componentInstance };
  }

  it('includes the visible review action in its accessible name', async () => {
    const { component, fixture } = await create();
    component.items.set([detail().listing]);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('.queue-card button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toContain(button.textContent?.trim());
    expect(button.getAttribute('aria-label')).toBe(
      'Review listing: <script>private title</script>'
    );
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
  });

  it('requires bounded nonblank rejection feedback and escapes private review text', async () => {
    const { component, fixture } = await create();
    await component.select('listing');
    component.reason.setValue('   ');
    component.confirm('reject');
    expect(component.confirmation()).toBeNull();
    component.reason.setValue('x'.repeat(2001));
    component.confirm('reject');
    expect(component.confirmation()).toBeNull();
    component.reason.setValue('Remove private address.');
    component.confirm('reject');
    expect(component.confirmation()).toBe('reject');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Private street');
    expect(fixture.nativeElement.textContent).toContain('administrator only');
  });

  it('allows rejection while publication readiness disables approval', async () => {
    const { component } = await create();
    api.detail.mockResolvedValueOnce({ ...detail(), canApprove: false });
    await component.select('listing');
    component.confirm('approve');
    expect(component.confirmation()).toBeNull();
    component.reason.setValue('Upload valid property photos.');
    component.confirm('reject');
    expect(component.confirmation()).toBe('reject');
  });

  it('prevents duplicate decisions and locks uncertain writes until saved detail reload succeeds', async () => {
    const { component } = await create();
    await component.select('listing');
    const pending = deferred<never>();
    api.decide.mockReturnValueOnce(pending.promise);
    component.confirm('approve');
    const first = component.decide();
    await component.decide();
    expect(api.decide).toHaveBeenCalledTimes(1);
    pending.resolve(Promise.reject(new HttpErrorResponse({ status: 0 })) as never);
    await first;
    expect(component.reloadRequired()).toBe(true);
    component.confirm('approve');
    await component.decide();
    expect(api.decide).toHaveBeenCalledTimes(1);
    await component.load(true);
    expect(component.reloadRequired()).toBe(true);
    await component.reload();
    expect(component.reloadRequired()).toBe(false);
  });

  it.each(['approve', 'reject'] as const)(
    'keeps %s confirmation named and disabled while saving',
    async (decision) => {
      const { component, fixture } = await create();
      await component.select('listing');
      component.reason.setValue('Remove the private address from your photos.');
      component.confirm(decision);
      await fixture.whenStable();
      const button = fixture.nativeElement.querySelector(
        '.confirmation button'
      ) as HTMLButtonElement;
      const name = decision === 'approve' ? 'Confirm approval' : 'Confirm rejection';
      expect(button.getAttribute('aria-label')).toBe(name);
      expect(button.getAttribute('aria-busy')).toBe('false');
      const pending = deferred<AdminDecisionResponse>();
      api.decide.mockReturnValueOnce(pending.promise);
      const work = component.decide();
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('.confirmation button')).toBe(button);
      expect(button.getAttribute('aria-label')).toBe(name);
      expect(button.textContent).toContain(name);
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.classList.contains('ant-btn-loading')).toBe(true);
      expect(button.disabled).toBe(true);
      button.click();
      await component.decide();
      expect(api.decide).toHaveBeenCalledTimes(1);
      const saved = detail();
      saved.listing.status = decision === 'approve' ? 'published' : 'rejected';
      saved.listing.version = 8;
      saved.canDecide = false;
      saved.canApprove = false;
      api.detail.mockResolvedValueOnce(saved);
      pending.resolve({
        id: 'listing',
        version: 8,
        status: saved.listing.status,
        rejectionReason: decision === 'reject' ? component.reason.value : null
      });
      await work;
    }
  );

  it('clears confidential content and ignores outstanding results after role or identity changes', async () => {
    const { component, fixture } = await create();
    await component.select('listing');
    const pending = deferred<AdminListingDetail>();
    api.detail.mockReturnValueOnce(pending.promise);
    const work = component.select('other');
    user.set({ ...admin, role: 'USER' });
    await fixture.whenStable();
    pending.resolve(detail('other'));
    await work;
    expect(component.review()).toBeNull();
    expect(component.items()).toEqual([]);
    expect(fixture.nativeElement.textContent).not.toContain('Private street');
    user.set({ ...admin, id: 'another-admin' });
    identity++;
    await fixture.whenStable();
    expect(component.review()).toBeNull();
  });

  it('discards old detail responses and fails closed on authorization rejection', async () => {
    const { component } = await create();
    const old = deferred<AdminListingDetail>();
    api.detail.mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail('new'));
    const work = component.select('old');
    await component.select('new');
    old.resolve(detail('old'));
    await work;
    expect(component.review()?.listing.id).toBe('new');
    api.detail.mockRejectedValueOnce(new HttpErrorResponse({ status: 403 }));
    await component.reload();
    expect(component.authorized()).toBe(false);
    expect(component.review()).toBeNull();
    expect(component.items()).toEqual([]);
  });

  it('reloads the saved decision and its history before another action is available', async () => {
    const { component, fixture } = await create();
    await component.select('listing');
    api.decide.mockResolvedValueOnce({
      id: 'listing',
      status: 'published',
      version: 8,
      rejectionReason: null
    });
    const saved = detail();
    saved.listing.status = 'published';
    saved.listing.version = 8;
    saved.canDecide = false;
    saved.canApprove = false;
    saved.history = [
      {
        id: 'audit',
        reviewerId: 'admin',
        reviewedVersion: 7,
        resultVersion: 8,
        decision: 'approved',
        reason: null,
        createdAt: '2026-11-07T00:00:00Z'
      }
    ];
    api.detail.mockResolvedValueOnce(saved);
    component.confirm('approve');
    await component.decide();
    await fixture.whenStable();
    expect(component.review()?.listing.version).toBe(8);
    expect(component.canDecide()).toBe(false);
    expect(component.confirmation()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Listing approved and published.');
    expect(fixture.nativeElement.textContent).toContain('Approved · Version 7');
  });

  it('cancels pending private work when a reused review route selects another listing', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'admin/listings/:id', component: AdminModeration }])]
    });
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl('/admin/listings/first', AdminModeration);
    await harness.fixture.whenStable();
    expect(component.review()?.listing.id).toBe('listing');
    const pending = deferred<AdminListingDetail>();
    api.detail.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(detail('second'));
    const old = component.select('first');
    const oldSignal = api.detail.mock.calls.at(-1)?.[1] as AbortSignal;
    await harness.navigateByUrl('/admin/listings/second', AdminModeration);
    await harness.fixture.whenStable();
    expect(oldSignal.aborted).toBe(true);
    pending.resolve(detail('first'));
    await old;
    expect(component.review()?.listing.id).toBe('second');
    expect(component.confirmation()).toBeNull();
  });
});
