import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { OwnerMediaAsset, OwnerMediaGallery } from '@viedom/contracts';
import { AuthSession } from '../../core/auth/auth-session';
import { OwnerMediaClient } from '../owner-media-client';
import { ListingPhotos } from './listing-photos';
import { ListingPhoto } from './listing-photo';

const id = '1'.repeat(24);
const asset = (mediaId: string, state: OwnerMediaAsset['state'] = 'queued'): OwnerMediaAsset => ({
  id: mediaId,
  state,
  errorCode: null,
  variants:
    state === 'ready'
      ? {
          large: { url: '/ignored', bytes: 1, width: 1, height: 1, contentType: 'image/webp' },
          thumbnail: { url: '/ignored', bytes: 1, width: 1, height: 1, contentType: 'image/webp' }
        }
      : null
});
const gallery = (version = 1, items: OwnerMediaAsset[] = []): OwnerMediaGallery => ({
  listingId: id,
  version,
  items,
  coverMediaId: null
});

describe('owner photo controls', () => {
  const user = signal<object | null>({ id: 'owner' });
  let identity = 0;
  const api = {
    gallery: vi.fn(),
    reserve: vi.fn(),
    upload: vi.fn(),
    complete: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    variant: vi.fn()
  };

  beforeEach(() => {
    identity = 0;
    user.set({ id: 'owner' });
    for (const method of Object.values(api)) method.mockReset();
    api.gallery.mockResolvedValue(gallery());
    api.upload.mockResolvedValue(undefined);
    api.variant.mockResolvedValue(new Blob(['photo']));
    TestBed.configureTestingModule({
      providers: [
        { provide: OwnerMediaClient, useValue: api },
        { provide: AuthSession, useValue: { user, identityVersion: () => identity } }
      ]
    });
    TestBed.overrideComponent(ListingPhotos, { set: { template: '' } });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup() {
    const fixture = TestBed.createComponent(ListingPhotos);
    fixture.componentRef.setInput('listingId', id);
    await fixture.whenStable();
    return { fixture, page: fixture.componentInstance };
  }

  const select = (files: File[]) => ({ target: { files, value: 'selected' } }) as unknown as Event;

  it('uses fresh versions for each sequential reservation and completion', async () => {
    const { page } = await setup();
    api.gallery
      .mockResolvedValueOnce(gallery(2))
      .mockResolvedValueOnce(gallery(4, [asset('a')]))
      .mockResolvedValueOnce(gallery(7, [asset('a')]))
      .mockResolvedValueOnce(gallery(9, [asset('a'), asset('b')]));
    api.reserve
      .mockResolvedValueOnce({ mediaId: 'a', gallery: gallery(3, [asset('a', 'awaiting_upload')]) })
      .mockResolvedValueOnce({
        mediaId: 'b',
        gallery: gallery(8, [asset('a'), asset('b', 'awaiting_upload')])
      });
    api.complete
      .mockResolvedValueOnce(gallery(5, [asset('a')]))
      .mockResolvedValueOnce(gallery(10, [asset('a'), asset('b')]));
    await page.select(
      select([
        new File(['a'], 'a.jpg', { type: 'image/jpeg' }),
        new File(['b'], 'b.png', { type: 'image/png' })
      ])
    );
    expect(api.reserve.mock.calls.map((call) => call[1].expectedVersion)).toEqual([2, 7]);
    expect(api.complete.mock.calls.map((call) => call[2])).toEqual([4, 9]);
    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(page.gallery()?.version).toBe(10);
  });

  it('uses the current ordered IDs for keyboard moves and only selects a ready cover', async () => {
    const { page } = await setup();
    api.gallery.mockResolvedValue(gallery(5, [asset('a'), asset('b', 'ready')]));
    api.update.mockResolvedValue(gallery(6, [asset('b', 'ready'), asset('a')]));
    await page.move('b', -1);
    expect(api.update).toHaveBeenCalledWith(
      id,
      { expectedVersion: 5, mediaIds: ['b', 'a'], coverMediaId: null },
      expect.any(AbortSignal)
    );
    await page.cover('a');
    expect(api.update).toHaveBeenCalledTimes(1);
    await page.cover('b');
    expect(api.update).toHaveBeenLastCalledWith(
      id,
      expect.objectContaining({ coverMediaId: 'b', expectedVersion: 5 }),
      expect.any(AbortSignal)
    );
  });

  it('locks uncertain API writes until explicit refresh and does not replay them', async () => {
    const { page } = await setup();
    const conflict = vi.fn();
    page.conflict.subscribe(conflict);
    api.remove.mockRejectedValue(new HttpErrorResponse({ status: 0 }));
    await page.remove('a');
    await page.remove('a');
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(page.mutationBlocked()).toBe(true);
    expect(conflict).toHaveBeenCalledTimes(1);
    await page.refresh();
    expect(page.mutationBlocked()).toBe(false);
  });

  it('retains an active upload across token refresh and releases its file after processing', async () => {
    const { fixture, page } = await setup();
    api.reserve.mockResolvedValue({
      mediaId: 'a',
      gallery: gallery(2, [asset('a', 'awaiting_upload')])
    });
    let finishUpload: () => void = () => {};
    api.upload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishUpload = resolve;
        })
    );
    api.complete.mockResolvedValue(gallery(3, [asset('a')]));
    const upload = page.select(select([new File(['a'], 'a.jpg', { type: 'image/jpeg' })]));
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    user.set({ id: 'owner' });
    await fixture.whenStable();
    expect(page.busy()).toBe(true);
    expect(page.hasFile('a')).toBe(true);
    expect(page.gallery()?.items[0]?.id).toBe('a');
    api.gallery.mockResolvedValue(gallery(2, [asset('a', 'awaiting_upload')]));
    finishUpload();
    await upload;
    api.gallery.mockResolvedValue(gallery(4, [asset('a', 'ready')]));
    await page.refresh();
    expect(page.hasFile('a')).toBe(false);
  });

  it('stops durable polling after session invalidation or component destruction', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api.gallery.mockResolvedValue(gallery(1, [asset('a')]));
    const { fixture } = await setup();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.gallery).toHaveBeenCalledTimes(2);
    identity++;
    user.set(null);
    await fixture.whenStable();
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.gallery).toHaveBeenCalledTimes(2);
    fixture.destroy();
    user.set({ id: 'owner' });
    const second = await setup();
    expect(api.gallery).toHaveBeenCalledTimes(3);
    second.fixture.destroy();
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.gallery).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid file batches and blocks writes while disabled', async () => {
    const { fixture, page } = await setup();
    await page.select(select([new File(['a'], 'bad.gif', { type: 'image/gif' })]));
    expect(page.error()).toContain('JPEG, PNG or WebP');
    expect(api.reserve).not.toHaveBeenCalled();
    fixture.componentRef.setInput('disabled', true);
    await page.remove('a');
    expect(api.remove).not.toHaveBeenCalled();
  });
});

describe('protected listing image lifetime', () => {
  const user = signal<object | null>({ id: 'owner' });
  const api = { variant: vi.fn() };
  let identity = 0;

  beforeEach(() => {
    user.set({ id: 'owner' });
    identity = 0;
    api.variant.mockReset().mockResolvedValue(new Blob(['processed']));
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, {
        createObjectURL: vi.fn(() => 'blob:private-photo'),
        revokeObjectURL: vi.fn()
      })
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: OwnerMediaClient, useValue: api },
        { provide: AuthSession, useValue: { user, identityVersion: () => identity } }
      ]
    });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function setup() {
    const fixture = TestBed.createComponent(ListingPhoto);
    fixture.componentRef.setInput('listingId', id);
    fixture.componentRef.setInput('mediaId', 'a');
    await fixture.whenStable();
    return fixture;
  }

  it('revokes private URLs and cancels reads on changes, signout and destroy', async () => {
    const fixture = await setup();
    expect(fixture.nativeElement.querySelector('img')?.getAttribute('src')).toBe(
      'blob:private-photo'
    );
    const firstSignal = api.variant.mock.calls[0]?.[3] as AbortSignal;
    fixture.componentRef.setInput('mediaId', 'b');
    await fixture.whenStable();
    expect(firstSignal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    identity++;
    user.set(null);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });

  it('discards late private bytes and allows retry after a delivery error', async () => {
    api.variant.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const fixture = await setup();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    fixture.componentInstance.retry();
    await fixture.whenStable();
    expect(api.variant).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.querySelector('img')).not.toBeNull();
  });

  it('discards private bytes when the account changes before its cleanup effect runs', async () => {
    let resolve!: (value: Blob) => void;
    api.variant.mockReturnValueOnce(new Promise<Blob>((done) => (resolve = done)));
    const fixture = await setup();
    user.set({ id: 'another-owner' });
    resolve(new Blob(['first owner private bytes']));
    await Promise.resolve();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await fixture.whenStable();
    expect(api.variant.mock.calls[0]?.[3].aborted).toBe(true);
    fixture.destroy();
  });
});

describe('photo gallery action labels', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('includes each visible photo action in its accessible name', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, {
        createObjectURL: vi.fn(() => 'blob:gallery-photo'),
        revokeObjectURL: vi.fn()
      })
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthSession,
          useValue: { user: signal({ id: 'owner' }), identityVersion: () => 0 }
        },
        {
          provide: OwnerMediaClient,
          useValue: {
            gallery: vi.fn().mockResolvedValue(gallery()),
            variant: vi.fn().mockResolvedValue(new Blob(['processed photo']))
          }
        }
      ]
    });
    const fixture = TestBed.createComponent(ListingPhotos);
    fixture.componentRef.setInput('listingId', id);
    await fixture.whenStable();
    vi.spyOn(fixture.componentInstance, 'hasFile').mockReturnValue(true);
    fixture.componentInstance.gallery.set(
      gallery(2, [asset('ready', 'ready'), asset('failed', 'failed')])
    );
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const actions = Array.from(
      element.querySelectorAll<HTMLButtonElement>('.photo-actions button')
    );
    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Move earlier: photo 1',
      'Move later: photo 1',
      'Use as cover: photo 1',
      'Delete photo 1',
      'Move earlier: photo 2',
      'Move later: photo 2',
      'Delete photo 2',
      'Retry upload: photo 2'
    ]);
    for (const button of actions) {
      expect(button.getAttribute('aria-label')).toContain(
        button.querySelector('span')?.textContent?.trim()
      );
    }
  });
});
