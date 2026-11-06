import { isPlatformBrowser } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked
} from '@angular/core';
import type {
  MediaState,
  OwnerMediaAsset,
  OwnerMediaGallery,
  UploadContentType
} from '@viedom/contracts';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { AuthSession } from '../../core/auth/auth-session';
import { OwnerMediaClient } from '../owner-media-client';
import { ListingPhoto } from './listing-photo';

interface GalleryScope {
  id: string;
  epoch: number;
  identity: number;
  signal: AbortSignal;
}

@Component({
  selector: 'app-listing-photos',
  imports: [NzButtonModule, ListingPhoto],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './listing-photos.html',
  styleUrl: './listing-photos.scss'
})
export class ListingPhotos {
  readonly listingId = input.required<string>();
  readonly disabled = input(false);
  readonly galleryChange = output<OwnerMediaGallery>();
  readonly busyChange = output<boolean>();
  readonly conflict = output<void>();
  readonly gallery = signal<OwnerMediaGallery | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly mutationBlocked = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly uploadProgress = signal<{ name: string; percent: number } | null>(null);
  readonly locked = computed(
    () =>
      this.disabled() || this.busy() || this.loading() || this.mutationBlocked() || !this.gallery()
  );
  private readonly api = inject(OwnerMediaClient);
  private readonly session = inject(AuthSession);
  private readonly account = computed(() => {
    const user = this.session.user();
    return user ? `${user.id}:${this.session.identityVersion()}` : '';
  });
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly files = new Map<string, File>();
  private controller = new AbortController();
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      const id = this.listingId();
      const account = this.account();
      untracked(() => {
        this.clear();
        if (this.browser && account && id) void this.refresh();
      });
    });
    inject(DestroyRef).onDestroy(() => this.clear(false));
  }

  private clear(emit = true): void {
    this.epoch++;
    this.controller.abort();
    this.controller = new AbortController();
    clearTimeout(this.timer);
    this.files.clear();
    this.gallery.set(null);
    this.loading.set(false);
    this.busy.set(false);
    this.mutationBlocked.set(false);
    this.error.set('');
    this.notice.set('');
    this.uploadProgress.set(null);
    if (emit) this.busyChange.emit(false);
  }

  private scope(): GalleryScope {
    return {
      id: this.listingId(),
      epoch: this.epoch,
      identity: this.session.identityVersion(),
      signal: this.controller.signal
    };
  }

  private current(scope: GalleryScope): boolean {
    return (
      !scope.signal.aborted &&
      scope.epoch === this.epoch &&
      scope.identity === this.session.identityVersion() &&
      !!this.session.user()
    );
  }

  private editable(scope: GalleryScope): void {
    if (!this.current(scope) || this.disabled())
      throw new DOMException('Photo editing stopped.', 'AbortError');
  }

  private apply(value: OwnerMediaGallery, scope: GalleryScope): void {
    if (
      !this.current(scope) ||
      value.listingId !== scope.id ||
      value.version < (this.gallery()?.version ?? 0)
    )
      return;
    this.gallery.set(value);
    for (const id of this.files.keys())
      if (!value.items.some((item) => item.id === id && item.state !== 'ready'))
        this.files.delete(id);
    this.galleryChange.emit(value);
  }

  private async latest(scope: GalleryScope): Promise<OwnerMediaGallery> {
    const gallery = await this.api.gallery(scope.id, scope.signal);
    if (!this.current(scope)) throw new DOMException('Photo request cancelled.', 'AbortError');
    this.apply(gallery, scope);
    return gallery;
  }

  async refresh(automatic = false): Promise<void> {
    if (this.busy() || this.loading() || !this.browser || !this.session.user()) return;
    const scope = this.scope();
    clearTimeout(this.timer);
    this.loading.set(true);
    this.error.set('');
    try {
      await this.latest(scope);
      if (this.current(scope) && !automatic) this.mutationBlocked.set(false);
    } catch (error) {
      if (this.current(scope)) this.showError(error);
    } finally {
      if (this.current(scope)) {
        this.loading.set(false);
        this.poll(scope);
      }
    }
  }

  private poll(scope: GalleryScope): void {
    clearTimeout(this.timer);
    if (
      !this.current(scope) ||
      !this.gallery()?.items.some((item) =>
        ['awaiting_upload', 'queued', 'processing'].includes(item.state)
      )
    )
      return;
    this.timer = setTimeout(() => {
      if (this.current(scope)) void this.refresh(true);
    }, 2000);
  }

  async select(event: Event, replaceId?: string): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length || this.locked()) return;
    const invalid = files.find((file) => !this.validFile(file));
    if (invalid) {
      this.error.set(`${invalid.name}: choose a JPEG, PNG or WebP photo from 1 byte to 10 MiB.`);
      return;
    }
    await this.run(async (scope) => {
      if (replaceId) await this.deleteAsset(scope, replaceId);
      for (const file of files) await this.upload(scope, file);
      this.notice.set('Photos uploaded. Processing continues automatically; you can return later.');
    });
  }

  async retry(id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file || this.locked()) return;
    await this.run(async (scope) => {
      await this.deleteAsset(scope, id);
      await this.upload(scope, file);
    });
  }

  hasFile(id: string): boolean {
    return this.files.has(id);
  }

  private validFile(file: File): boolean {
    return (
      ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) &&
      file.size > 0 &&
      file.size <= 10 * 1024 * 1024
    );
  }

  private async upload(scope: GalleryScope, file: File): Promise<void> {
    const latest = await this.latest(scope);
    this.editable(scope);
    if (latest.items.length >= 20)
      throw new Error('The gallery holds 20 photos. Delete a photo before adding another.');
    this.uploadProgress.set({ name: file.name, percent: 0 });
    const reservation = await this.mutate(() =>
      this.api.reserve(
        scope.id,
        {
          expectedVersion: latest.version,
          contentType: file.type as UploadContentType,
          bytes: file.size
        },
        scope.signal
      )
    );
    if (!this.current(scope)) return;
    this.files.set(reservation.mediaId, file);
    this.apply(reservation.gallery, scope);
    this.editable(scope);
    await this.api.upload(
      reservation,
      file,
      (percent) => {
        if (this.current(scope)) this.uploadProgress.set({ name: file.name, percent });
      },
      scope.signal
    );
    const current = await this.latest(scope);
    this.editable(scope);
    this.apply(
      await this.mutate(() =>
        this.api.complete(scope.id, reservation.mediaId, current.version, scope.signal)
      ),
      scope
    );
    this.uploadProgress.set(null);
  }

  async remove(id: string): Promise<void> {
    await this.run(async (scope) => {
      await this.deleteAsset(scope, id);
      this.notice.set('Photo deleted.');
    });
  }

  private async deleteAsset(scope: GalleryScope, id: string): Promise<void> {
    const latest = await this.latest(scope);
    this.editable(scope);
    this.apply(
      await this.mutate(() => this.api.remove(scope.id, id, latest.version, scope.signal)),
      scope
    );
    this.files.delete(id);
  }

  async move(id: string, direction: -1 | 1): Promise<void> {
    await this.run(async (scope) => {
      const latest = await this.latest(scope);
      const ids = latest.items.map((item) => item.id);
      const index = ids.indexOf(id);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= ids.length) return;
      const target = ids[next];
      if (target === undefined) return;
      ids[next] = id;
      ids[index] = target;
      this.editable(scope);
      this.apply(
        await this.mutate(() =>
          this.api.update(
            scope.id,
            { expectedVersion: latest.version, mediaIds: ids, coverMediaId: latest.coverMediaId },
            scope.signal
          )
        ),
        scope
      );
      this.notice.set(`Photo moved to position ${next + 1}.`);
    });
  }

  async cover(id: string): Promise<void> {
    await this.run(async (scope) => {
      const latest = await this.latest(scope);
      const asset = latest.items.find((item) => item.id === id);
      if (asset?.state !== 'ready' || !asset.variants) return;
      this.editable(scope);
      this.apply(
        await this.mutate(() =>
          this.api.update(
            scope.id,
            {
              expectedVersion: latest.version,
              mediaIds: latest.items.map((item) => item.id),
              coverMediaId: id
            },
            scope.signal
          )
        ),
        scope
      );
      this.notice.set('Cover photo updated.');
    });
  }

  private async run(operation: (scope: GalleryScope) => Promise<void>): Promise<void> {
    if (this.locked() || !this.session.user()) return;
    const scope = this.scope();
    clearTimeout(this.timer);
    this.busy.set(true);
    this.busyChange.emit(true);
    this.error.set('');
    this.notice.set('');
    try {
      await operation(scope);
    } catch (error) {
      if (this.current(scope)) this.showError(error);
    } finally {
      if (this.current(scope)) {
        this.uploadProgress.set(null);
        this.busy.set(false);
        this.busyChange.emit(false);
        this.poll(scope);
      }
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    try {
      return await operation();
    } catch (error) {
      if (
        epoch === this.epoch &&
        this.session.user() &&
        error instanceof HttpErrorResponse &&
        (error.status === 0 || error.status >= 500)
      ) {
        this.mutationBlocked.set(true);
        this.conflict.emit();
      }
      throw error;
    }
  }

  private showError(error: unknown): void {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (error instanceof HttpErrorResponse) {
      if (error.status === 409) {
        this.mutationBlocked.set(true);
        this.error.set('The listing changed. Reload saved data before editing photos again.');
        this.conflict.emit();
      } else if (error.status === 429)
        this.error.set('The upload limit was reached. Try again later.');
      else if (error.status === 401 || error.status === 403)
        this.error.set(
          'Your account cannot edit these photos. Check your session and account status.'
        );
      else if (error.status === 400 || error.status === 413)
        this.error.set(
          'This photo was not accepted. Choose a JPEG, PNG or WebP photo up to 10 MiB.'
        );
      else
        this.error.set(
          'The photo request could not be confirmed. Refresh photos to check the saved result before trying again.'
        );
    } else
      this.error.set(
        error instanceof Error
          ? error.message
          : 'Photos could not be updated. Refresh and try again.'
      );
  }

  stateLabel(asset: OwnerMediaAsset): string {
    const labels: Record<MediaState, string> = {
      awaiting_upload: 'Awaiting upload',
      queued: 'Queued for processing',
      processing: 'Processing photo',
      ready: 'Ready',
      failed: 'Photo failed',
      deleted: 'Deleted'
    };
    if (asset.state === 'failed')
      return asset.errorCode === 'invalid_image'
        ? 'Photo failed: the image is invalid or unsupported. Choose another photo.'
        : 'Photo failed: processing could not finish. Retry or choose another photo.';
    return labels[asset.state];
  }
}
