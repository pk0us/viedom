import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { BehaviorSubject } from 'rxjs';
import type { OwnerListingDetail, OwnerProperty } from '@viedom/contracts';
import { AuthSession } from '../../core/auth/auth-session';
import { OwnerListingsClient } from '../owner-listings-client';
import { emptyDraft, listingContent, propertyContent } from './listing-editor-model';
import { ListingEditor } from './listing-editor';
import { unsavedListingGuard } from '../unsaved-listing-guard';

const id = '1'.repeat(24);
const propertyId = '2'.repeat(24);
const validModel = {
  ...emptyDraft(),
  area: '75',
  price: '850.29',
  title: 'A comfortable home',
  description: 'A comfortable home with a bright balcony.'
};
const property: OwnerProperty = {
  ...propertyContent(validModel),
  id: propertyId,
  version: 1,
  publicLocation: { type: 'Point', coordinates: [22.94, 40.64] },
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:00.000Z'
};
const detail: OwnerListingDetail = {
  ...listingContent(validModel),
  id,
  propertyId,
  propertyVersion: 1,
  version: 1,
  property,
  status: 'draft',
  moderationHold: false,
  submittedVersion: null,
  publishedAt: null,
  expiresAt: null,
  createdAt: property.createdAt,
  updatedAt: property.updatedAt,
  submission: { canSubmit: false, missing: ['processedMedia'] }
};

describe('owner draft saves', () => {
  let api: {
    [
      K in
        | 'detail'
        | 'createProperty'
        | 'getProperty'
        | 'updateProperty'
        | 'createListing'
        | 'updateListing'
        | 'action'
        | 'preview'
    ]: ReturnType<typeof vi.fn>;
  };
  let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let user: ReturnType<typeof signal<object | null>>;

  beforeEach(() => {
    api = {
      detail: vi.fn().mockResolvedValue(detail),
      createProperty: vi.fn().mockResolvedValue(property),
      getProperty: vi.fn().mockResolvedValue(property),
      updateProperty: vi.fn(),
      createListing: vi.fn().mockResolvedValue(detail),
      updateListing: vi.fn().mockResolvedValue(detail),
      action: vi.fn(),
      preview: vi.fn()
    };
    params = new BehaviorSubject(convertToParamMap({}));
    user = signal<object | null>({ id: 'owner' });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: OwnerListingsClient, useValue: api },
        { provide: AuthSession, useValue: { user, identityVersion: () => 0 } },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: params, snapshot: { paramMap: convertToParamMap({}) } }
        }
      ]
    });
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('does not duplicate a property after a listing validation failure', async () => {
    const fixture = TestBed.createComponent(ListingEditor);
    const page = fixture.componentInstance;
    page.model.set(validModel);
    api.createListing.mockRejectedValueOnce(new HttpErrorResponse({ status: 400 }));
    await page.save(new Event('submit'));
    expect(api.createProperty).toHaveBeenCalledTimes(1);
    expect(page.reloadRequired()).toBe(true);
    await page.reload();
    await page.save(new Event('submit'));
    expect(api.createProperty).toHaveBeenCalledTimes(1);
    expect(api.createListing).toHaveBeenCalledTimes(2);
    expect(api.createListing).toHaveBeenLastCalledWith(
      expect.objectContaining({ propertyId, expectedPropertyVersion: 1, priceMinor: 85029 })
    );
  });

  it('saves only changed listing text without rewriting the canonical property', async () => {
    params.next(convertToParamMap({ id }));
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    await page.load();
    page.model.update((model) => ({ ...model, title: 'An updated title' }));
    await page.save(new Event('submit'));
    expect(api.updateProperty).not.toHaveBeenCalled();
    expect(api.updateListing).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ expectedVersion: 1, title: 'An updated title' })
    );
  });

  it('uses the listing version produced by property withdrawal', async () => {
    params.next(convertToParamMap({ id }));
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    await page.load();
    api.updateProperty.mockResolvedValue({ ...property, version: 2 });
    api.detail.mockResolvedValue({
      ...detail,
      version: 2,
      propertyVersion: 2,
      property: { ...property, version: 2, details: { ...property.details, areaM2: 90 } }
    });
    page.model.update((model) => ({ ...model, area: '90', title: 'An updated title' }));
    await page.save(new Event('submit'));
    expect(api.updateProperty).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({ expectedVersion: 1 })
    );
    expect(api.updateListing).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ expectedVersion: 2 })
    );
  });

  it('requires reload rather than overwriting an intervening listing edit', async () => {
    params.next(convertToParamMap({ id }));
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    await page.load();
    api.updateProperty.mockResolvedValue({ ...property, version: 2 });
    api.detail.mockResolvedValue({ ...detail, version: 3, title: 'Other tab title' });
    page.model.update((model) => ({ ...model, area: '90', title: 'An updated title' }));
    await page.save(new Event('submit'));
    expect(api.updateListing).not.toHaveBeenCalled();
    expect(page.reloadRequired()).toBe(true);
    expect(page.model().title).toBe('An updated title');
  });

  it('blocks ambiguous writes and prevents repeated mutations before reload', async () => {
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    page.model.set(validModel);
    api.createProperty.mockRejectedValue(new HttpErrorResponse({ status: 0 }));
    await page.save(new Event('submit'));
    await page.save(new Event('submit'));
    expect(api.createProperty).toHaveBeenCalledTimes(1);
    expect(page.reloadRequired()).toBe(true);
  });

  it('keeps an ambiguous new listing locked after checking its property', async () => {
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    page.model.set(validModel);
    api.createListing.mockRejectedValue(new HttpErrorResponse({ status: 0 }));
    await page.save(new Event('submit'));
    expect(page.uncertainCreation()).toBe(true);
    await page.reload();
    await page.save(new Event('submit'));
    expect(api.getProperty).not.toHaveBeenCalled();
    expect(api.createListing).toHaveBeenCalledTimes(1);
    expect(page.reloadRequired()).toBe(true);
  });

  it('protects unsaved input but allows an invalidated session to leave', () => {
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    page.model.set(validModel);
    vi.mocked(window.confirm).mockReturnValue(false);
    expect(page.canLeave()).toBe(false);
    page.busy.set(true);
    expect(page.canLeave()).toBe(false);
    user.set(null);
    expect(page.canLeave()).toBe(true);
  });

  it('adopts media versions without discarding unsaved input, but blocks concurrent content changes', async () => {
    params.next(convertToParamMap({ id }));
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    await page.load();
    page.model.update((value) => ({ ...value, title: 'My unsaved title' }));
    api.detail.mockResolvedValue({
      ...detail,
      version: 3,
      submission: { canSubmit: true, missing: [] }
    });
    await page.galleryChanged({ listingId: id, version: 3, coverMediaId: null, items: [] });
    expect(page.detail()?.version).toBe(3);
    expect(page.model().title).toBe('My unsaved title');
    expect(page.reloadRequired()).toBe(false);
    api.detail.mockResolvedValue({ ...detail, version: 4, title: 'Another tab title' });
    await page.galleryChanged({ listingId: id, version: 4, coverMediaId: null, items: [] });
    expect(page.reloadRequired()).toBe(true);
    expect(page.model().title).toBe('My unsaved title');
  });

  it('submits the current version once and never presents submission as publication', async () => {
    params.next(convertToParamMap({ id }));
    const ready = { ...detail, version: 7, submission: { canSubmit: true, missing: [] } };
    api.detail.mockResolvedValue(ready);
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    await page.load();
    let finish!: (value: OwnerListingDetail) => void;
    api.action.mockImplementation(
      () =>
        new Promise<OwnerListingDetail>((resolve) => {
          finish = resolve;
        })
    );
    const pending = page.requestReview();
    await page.requestReview();
    expect(api.action).toHaveBeenCalledTimes(1);
    expect(api.action).toHaveBeenCalledWith(id, 'submit', 7);
    finish({ ...ready, version: 8, status: 'pending_review', submittedVersion: 8 });
    await pending;
    expect(page.detail()?.status).toBe('pending_review');
    expect(page.success()).toContain('not published');
    await page.requestReview();
    expect(api.action).toHaveBeenCalledTimes(1);
  });

  it('locks an uncertain review request until reload and does not replay it', async () => {
    params.next(convertToParamMap({ id }));
    api.detail.mockResolvedValue({ ...detail, submission: { canSubmit: true, missing: [] } });
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    await page.load();
    api.action.mockRejectedValue(new HttpErrorResponse({ status: 0 }));
    await page.requestReview();
    await page.requestReview();
    expect(page.reloadRequired()).toBe(true);
    expect(api.action).toHaveBeenCalledTimes(1);
  });

  it('uses resume for paused listings and blocks unsaved and incomplete requests', async () => {
    params.next(convertToParamMap({ id }));
    api.detail.mockResolvedValue({
      ...detail,
      status: 'paused',
      submission: { canSubmit: true, missing: [] }
    });
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    await page.load();
    page.model.update((value) => ({ ...value, title: 'Unsaved title' }));
    await page.requestReview();
    expect(api.action).not.toHaveBeenCalled();
    await page.load();
    api.action.mockResolvedValue({ ...detail, status: 'pending_review' });
    await page.requestReview();
    expect(api.action).toHaveBeenCalledWith(id, 'resume', 1);
    await page.load();
    page.detail.set(detail);
    await page.requestReview();
    expect(api.action).toHaveBeenCalledTimes(1);
  });

  it('discards a preview from a previous session and rejects a stale preview version', async () => {
    params.next(convertToParamMap({ id }));
    const page = TestBed.createComponent(ListingEditor).componentInstance;
    await page.load();
    api.preview.mockResolvedValue({ version: 2 });
    await page.showPreview();
    expect(page.preview()).toBeNull();
    expect(page.reloadRequired()).toBe(true);
    await page.load();
    let finish!: (value: unknown) => void;
    api.preview.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = page.showPreview();
    user.set(null);
    finish({ version: 1 });
    await pending;
    expect(page.preview()).toBeNull();
  });
});

describe('draft navigation protection', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('protects unsaved changes when another listing reuses the editor route', async () => {
    const otherId = '3'.repeat(24);
    const api = { detail: vi.fn().mockResolvedValue(detail) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'owner/listings/:id',
            component: ListingEditor,
            canDeactivate: [unsavedListingGuard]
          }
        ]),
        { provide: OwnerListingsClient, useValue: api },
        {
          provide: AuthSession,
          useValue: { user: signal({ id: 'owner' }), identityVersion: () => 0 }
        }
      ]
    });
    TestBed.overrideComponent(ListingEditor, { set: { template: '' } });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl(`/owner/listings/${id}`, ListingEditor);
    await page.load();
    page.model.update((model) => ({ ...model, title: 'Unsaved changes' }));
    await harness.navigateByUrl(`/owner/listings/${otherId}`);
    expect(TestBed.inject(Router).url).toBe(`/owner/listings/${id}`);
    expect(window.confirm).toHaveBeenCalledWith('Leave without saving your changes?');
    expect(api.detail).not.toHaveBeenCalledWith(otherId);
  });
});
