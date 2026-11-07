import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  signal
} from '@angular/core';
import { AuthSession } from '../../core/auth/auth-session';
import { OwnerMediaClient } from '../owner-media-client';
import { NzButtonModule } from 'ng-zorro-antd/button';

@Component({
  selector: 'app-listing-photo',
  imports: [NzButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (url(); as source) {
      <img [src]="source" [alt]="alt()" loading="lazy" decoding="async" />
    } @else {
      <span role="status">{{ failed() ? 'Photo unavailable.' : 'Loading photo…' }}</span>
      @if (failed()) {
        <button nz-button type="button" (click)="retry()"><span>Retry photo preview</span></button>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      place-items: center;
      min-height: 160px;
      background: #f5f7fa;
      border-radius: 8px;
      overflow: hidden;
    }
    img {
      display: block;
      width: 100%;
      height: 100%;
      max-height: 640px;
      object-fit: contain;
    }
    span {
      padding: 16px;
      color: #526477;
    }
    button {
      margin: 0 16px 16px;
      min-height: 44px;
    }
  `
})
export class ListingPhoto {
  readonly listingId = input.required<string>();
  readonly mediaId = input.required<string>();
  readonly variant = input<'large' | 'thumbnail'>('thumbnail');
  readonly alt = input('Listing photo');
  readonly url = signal('');
  readonly failed = signal(false);
  private readonly attempt = signal(0);
  private readonly api = inject(OwnerMediaClient);
  private readonly session = inject(AuthSession);
  private readonly account = computed(() => {
    const user = this.session.user();
    return user ? `${user.id}:${user.role}:${this.session.identityVersion()}` : '';
  });
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  constructor() {
    effect((cleanup) => {
      const listingId = this.listingId();
      const mediaId = this.mediaId();
      const variant = this.variant();
      this.attempt();
      const account = this.account();
      const identity = this.session.identityVersion();
      const abort = new AbortController();
      let objectUrl = '';
      this.url.set('');
      this.failed.set(false);
      cleanup(() => {
        abort.abort();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        this.url.set('');
      });
      if (!this.browser || !account || !listingId || !mediaId) return;
      void this.api
        .variant(listingId, mediaId, variant, abort.signal)
        .then((blob) => {
          if (
            abort.signal.aborted ||
            identity !== this.session.identityVersion() ||
            account !== this.account() ||
            !this.session.user()
          )
            return;
          objectUrl = URL.createObjectURL(blob);
          this.url.set(objectUrl);
        })
        .catch(() => {
          if (!abort.signal.aborted) this.failed.set(true);
        });
    });
  }

  retry(): void {
    this.attempt.update((value) => value + 1);
  }
}
