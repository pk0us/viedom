import { DatePipe, DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NzButtonModule } from 'ng-zorro-antd/button';
import type { AdminListingDetail, OwnerListingSummary } from '@viedom/contracts';
import { AuthSession } from '../../core/auth/auth-session';
import { PricePipe } from '../../shared/price-pipe';
import { UiState } from '../../shared/ui-state/ui-state';
import { ListingPhoto } from '../listing-photos/listing-photo';
import { OwnerMediaClient } from '../owner-media-client';
import { AdminListingsClient } from './admin-listings-client';

@Component({
  selector: 'app-admin-moderation',
  imports: [DatePipe, ReactiveFormsModule, NzButtonModule, PricePipe, UiState, ListingPhoto],
  providers: [{ provide: OwnerMediaClient, useExisting: AdminListingsClient }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-moderation.html',
  styleUrl: './admin-moderation.scss'
})
export class AdminModeration {
  private readonly api = inject(AdminListingsClient);
  private readonly session = inject(AuthSession);
  private readonly document = inject(DOCUMENT);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly authorized = computed(() => this.session.user()?.role === 'ADMIN' && !this.denied());
  private readonly account = computed(() => {
    const user = this.session.user();
    return user ? `${user.id}:${user.role}:${this.session.identityVersion()}` : '';
  });
  readonly denied = signal(false);
  readonly items = signal<OwnerListingSummary[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly loading = signal(true);
  readonly queueError = signal('');
  readonly review = signal<AdminListingDetail | null>(null);
  readonly reviewing = signal(false);
  readonly reviewError = signal('');
  readonly busy = signal(false);
  readonly reloadRequired = signal(false);
  readonly notice = signal('');
  readonly confirmation = signal<'approve' | 'reject' | null>(null);
  readonly reason = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(2000)]
  });
  readonly readyMedia = computed(
    () => this.review()?.media.items.filter((item) => item.state === 'ready' && item.variants) ?? []
  );
  private selectedId = '';
  private queueAbort?: AbortController;
  private detailAbort?: AbortController;
  private decisionAbort?: AbortController;
  private epoch = 0;
  private destroyed = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      this.route.paramMap.pipe(takeUntilDestroyed(destroyRef)).subscribe((params) => {
        this.clear();
        void this.load(true);
        const id = params.get('id');
        if (id) void this.select(id, true);
      });
    });
    effect(() => {
      this.account();
      this.clear();
    });
    destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.clear();
    });
  }

  private clear(): void {
    this.epoch++;
    this.queueAbort?.abort();
    this.detailAbort?.abort();
    this.decisionAbort?.abort();
    this.items.set([]);
    this.nextCursor.set(null);
    this.review.set(null);
    this.selectedId = '';
    this.reason.reset();
    this.confirmation.set(null);
    this.busy.set(false);
    this.reviewing.set(false);
    this.loading.set(false);
    this.notice.set('');
    this.queueError.set('');
    this.reviewError.set('');
    this.reloadRequired.set(false);
  }

  private current(epoch: number, account: string, abort: AbortController): boolean {
    return (
      !this.destroyed &&
      !abort.signal.aborted &&
      epoch === this.epoch &&
      account === this.account() &&
      this.authorized()
    );
  }

  private deny(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse) || ![401, 403].includes(error.status)) return false;
    this.clear();
    this.denied.set(true);
    return true;
  }

  async load(reset = false): Promise<void> {
    if (!this.authorized() || this.busy() || (!reset && (this.loading() || !this.nextCursor())))
      return;
    this.queueAbort?.abort();
    const abort = (this.queueAbort = new AbortController());
    const epoch = this.epoch;
    const account = this.account();
    const cursor = reset ? undefined : (this.nextCursor() ?? undefined);
    if (reset) {
      this.items.set([]);
      this.nextCursor.set(null);
    }
    this.loading.set(true);
    this.queueError.set('');
    try {
      const result = await this.api.list(cursor, abort.signal);
      if (!this.current(epoch, account, abort)) return;
      this.items.update((previous) => [
        ...previous,
        ...result.items.filter((item) => !previous.some((old) => old.id === item.id))
      ]);
      this.nextCursor.set(result.nextCursor);
    } catch (error) {
      if (this.current(epoch, account, abort) && !this.deny(error))
        this.queueError.set('The pending queue could not be loaded. Try again.');
    } finally {
      if (this.current(epoch, account, abort)) this.loading.set(false);
    }
  }

  async select(id: string, reload = false): Promise<void> {
    if (!this.authorized() || this.busy() || (this.reloadRequired() && !reload)) return;
    this.detailAbort?.abort();
    const abort = (this.detailAbort = new AbortController());
    const epoch = this.epoch;
    const account = this.account();
    this.selectedId = id;
    this.review.set(null);
    this.confirmation.set(null);
    this.reason.reset();
    this.reviewing.set(true);
    this.reviewError.set('');
    try {
      const result = await this.api.detail(id, abort.signal);
      if (!this.current(epoch, account, abort)) return;
      this.review.set(result);
      this.reloadRequired.set(false);
      this.notice.set('');
      requestAnimationFrame(() => {
        if (this.current(epoch, account, abort))
          this.document.getElementById('review-heading')?.focus();
      });
    } catch (error) {
      if (this.current(epoch, account, abort) && !this.deny(error))
        this.reviewError.set(
          'Review details are unavailable. Reload the review to check its current state.'
        );
    } finally {
      if (this.current(epoch, account, abort)) this.reviewing.set(false);
    }
  }

  async reload(): Promise<void> {
    if (this.selectedId) await this.select(this.selectedId, true);
    await this.load(true);
  }

  open(id: string): void {
    if (this.busy() || this.reloadRequired()) return;
    void this.router.navigate(['/admin/listings', id]);
  }

  canDecide(): boolean {
    const review = this.review();
    return (
      this.authorized() &&
      !this.busy() &&
      !this.reviewing() &&
      !this.reloadRequired() &&
      !!review?.canDecide &&
      review.listing.status === 'pending_review'
    );
  }

  confirm(decision: 'approve' | 'reject'): void {
    if (!this.canDecide() || (decision === 'approve' && !this.review()?.canApprove)) return;
    if (decision === 'reject') this.reason.markAsTouched();
    if (decision === 'reject' && (!this.reason.value.trim() || this.reason.invalid)) {
      this.document.getElementById('rejection-reason')?.focus();
      return;
    }
    this.confirmation.set(decision);
    const epoch = this.epoch;
    const account = this.account();
    requestAnimationFrame(() => {
      if (
        !this.destroyed &&
        epoch === this.epoch &&
        account === this.account() &&
        this.authorized() &&
        this.confirmation() === decision
      )
        this.document.getElementById('decision-heading')?.focus();
    });
  }

  cancel(): void {
    if (this.busy()) return;
    const decision = this.confirmation();
    this.confirmation.set(null);
    this.document
      .getElementById(decision === 'approve' ? 'approve-listing' : 'reject-listing')
      ?.focus();
  }

  async decide(): Promise<void> {
    const review = this.review();
    const decision = this.confirmation();
    if (!review || !decision || !this.canDecide() || (decision === 'approve' && !review.canApprove))
      return;
    const reason = this.reason.value.trim();
    if (decision === 'reject' && (!reason || reason.length > 2000)) return;
    const abort = (this.decisionAbort = new AbortController());
    const epoch = this.epoch;
    const account = this.account();
    this.busy.set(true);
    try {
      const result = await this.api.decide(
        review.listing.id,
        decision,
        review.listing.version,
        reason,
        abort.signal
      );
      if (!this.current(epoch, account, abort)) return;
      this.confirmation.set(null);
      this.review.set(null);
      this.reason.reset();
      this.busy.set(false);
      await this.select(review.listing.id, true);
      if (!this.current(epoch, account, abort)) return;
      this.notice.set(
        result.status === 'published'
          ? 'Listing approved and published.'
          : 'Listing rejected. The owner can see your feedback.'
      );
      await this.load(true);
      requestAnimationFrame(() => {
        if (this.current(epoch, account, abort))
          this.document.getElementById('decision-result')?.focus();
      });
    } catch (error) {
      if (!this.current(epoch, account, abort) || this.deny(error)) return;
      this.confirmation.set(null);
      this.reloadRequired.set(true);
      this.notice.set(
        error instanceof HttpErrorResponse && error.status === 409
          ? 'This submission has changed or was already decided. Reload the review before continuing.'
          : 'The decision result could not be confirmed. Reload the review to check saved state before taking another action.'
      );
    } finally {
      if (this.current(epoch, account, abort)) this.busy.set(false);
    }
  }
}
