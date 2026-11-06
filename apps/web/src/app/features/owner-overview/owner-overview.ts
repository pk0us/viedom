import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  effect,
  inject,
  signal
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import type { ListingStatus, OwnerListingSummary } from '@viedom/contracts';
import { AuthSession } from '../../core/auth/auth-session';
import { PricePipe } from '../../shared/price-pipe';
import { UiState } from '../../shared/ui-state/ui-state';
import { OwnerListingsClient } from '../owner-listings-client';

const statuses: { value: ListingStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'pending_review', label: 'Pending review' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'published', label: 'Published' },
  { value: 'paused', label: 'Paused' },
  { value: 'archived', label: 'Archived' }
];

@Component({
  imports: [UiState, RouterLink, NzButtonModule, PricePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-owner-overview',
  styleUrl: './owner-overview.scss',
  templateUrl: './owner-overview.html'
})
export class OwnerOverview {
  private readonly api = inject(OwnerListingsClient);
  private readonly document = inject(DOCUMENT);
  readonly session = inject(AuthSession);
  readonly checking = signal(false);
  readonly error = signal(false);
  readonly statuses = statuses;
  readonly status = signal<ListingStatus | ''>('');
  readonly items = signal<OwnerListingSummary[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);
  readonly reloadRequired = signal(false);
  readonly confirmation = signal<{
    listing: OwnerListingSummary;
    action: 'pause' | 'archive';
  } | null>(null);
  private request = 0;
  private destroyed = false;

  constructor() {
    afterNextRender(() => void this.load(true));
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.request++;
    });
    effect(() => {
      if (!this.session.user()) {
        this.request++;
        this.items.set([]);
        this.confirmation.set(null);
        this.nextCursor.set(null);
        this.loading.set(false);
      }
    });
  }

  statusLabel(value: ListingStatus): string {
    return statuses.find((status) => status.value === value)?.label ?? value;
  }

  async filter(event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value;
    this.status.set(
      statuses.some((status) => status.value === value) ? (value as ListingStatus) : ''
    );
    this.confirmation.set(null);
    this.notice.set('');
    await this.load(true);
  }

  async load(reset = false): Promise<void> {
    if (this.destroyed || !this.session.user() || (!reset && this.loading())) return;
    const request = ++this.request;
    const identity = this.session.identityVersion();
    const cursor = reset ? undefined : (this.nextCursor() ?? undefined);
    if (reset) {
      this.items.set([]);
      this.nextCursor.set(null);
      this.confirmation.set(null);
    }
    this.loading.set(true);
    this.listError.set('');
    try {
      const result = await this.api.list(this.status() || undefined, cursor);
      if (!this.current(request, identity)) return;
      this.items.update((items) => {
        const previous = reset ? [] : items;
        const seen = new Set(previous.map((item) => item.id));
        return [...previous, ...result.items.filter((item) => !seen.has(item.id))];
      });
      this.nextCursor.set(result.nextCursor);
      this.reloadRequired.set(false);
    } catch {
      if (this.current(request, identity))
        this.listError.set(
          'Your listings could not be loaded. Check your connection and try again.'
        );
    } finally {
      if (this.current(request, identity)) this.loading.set(false);
    }
  }

  confirm(listing: OwnerListingSummary, action: 'pause' | 'archive'): void {
    if (this.busy() || this.reloadRequired()) return;
    this.confirmation.set({ listing, action });
    this.notice.set('');
  }

  cancel(): void {
    if (this.busy()) return;
    const id = this.confirmation()?.listing.id;
    const action = this.confirmation()?.action;
    this.confirmation.set(null);
    if (id && action) this.document.getElementById(`${action}-${id}`)?.focus();
  }

  async applyAction(): Promise<void> {
    const confirmation = this.confirmation();
    if (!confirmation || this.busy() || this.reloadRequired()) return;
    this.busy.set(true);
    const identity = this.session.identityVersion();
    try {
      await this.api.action(
        confirmation.listing.id,
        confirmation.action,
        confirmation.listing.version
      );
      if (this.destroyed || identity !== this.session.identityVersion()) return;
      this.confirmation.set(null);
      this.notice.set(confirmation.action === 'archive' ? 'Listing archived.' : 'Listing paused.');
      await this.load(true);
    } catch (error) {
      if (this.destroyed || identity !== this.session.identityVersion()) return;
      this.confirmation.set(null);
      this.reloadRequired.set(true);
      this.notice.set(
        error instanceof HttpErrorResponse && error.status === 409
          ? 'This listing has changed or this action is no longer available. Reload listings before continuing.'
          : 'We could not confirm the result. Reload listings to check the current state before trying again.'
      );
    } finally {
      if (!this.destroyed && identity === this.session.identityVersion()) this.busy.set(false);
    }
  }

  private current(request: number, identity: number): boolean {
    return (
      !this.destroyed && request === this.request && identity === this.session.identityVersion()
    );
  }

  async checkAccount(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    this.error.set(false);
    try {
      await this.session.reloadUser();
    } catch {
      this.error.set(true);
    } finally {
      this.checking.set(false);
    }
  }
}
