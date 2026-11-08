import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked
} from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import type { InquiryStatus, OwnerInquiry } from '@viedom/contracts';
import { AuthSession } from '../../core/auth/auth-session';
import { UiState } from '../../shared/ui-state/ui-state';
import { InquiriesClient } from '../inquiries-client';

@Component({
  selector: 'app-owner-inquiries',
  imports: [DatePipe, NzButtonModule, UiState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './owner-inquiries.html',
  styleUrl: './owner-inquiries.scss'
})
export class OwnerInquiries {
  private readonly api = inject(InquiriesClient);
  private readonly session = inject(AuthSession);
  private readonly storedItems = signal<OwnerInquiry[]>([]);
  private readonly loadedFor = signal<string | null>(null);
  readonly items = computed(() =>
    this.loadedFor() === this.session.user()?.id ? this.storedItems() : []
  );
  readonly loading = signal(true);
  readonly nextCursor = signal<string | null>(null);
  readonly listError = signal('');
  readonly actionError = signal('');
  readonly notice = signal('');
  readonly busyId = signal<string | null>(null);
  private request = 0;
  private destroyed = false;
  private rendered = false;

  constructor() {
    afterNextRender(() => {
      this.rendered = true;
      void this.load(true);
    });
    effect(() => {
      const userId = this.session.user()?.id;
      untracked(() => {
        if (userId === this.loadedFor()) return;
        this.request++;
        this.storedItems.set([]);
        this.nextCursor.set(null);
        this.loadedFor.set(userId ?? null);
        this.busyId.set(null);
        this.notice.set('');
        this.actionError.set('');
        this.listError.set('');
        if (!userId) this.loading.set(false);
        else if (this.rendered) void this.load(true);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.request++;
    });
  }

  async load(reset = false): Promise<void> {
    const user = this.session.user();
    if (this.destroyed || !user || this.busyId() || (!reset && this.loading())) return;
    const request = ++this.request;
    const identity = this.session.identityVersion();
    const cursor = reset ? undefined : (this.nextCursor() ?? undefined);
    if (reset) {
      this.storedItems.set([]);
      this.nextCursor.set(null);
    }
    this.loadedFor.set(user.id);
    this.loading.set(true);
    this.listError.set('');
    try {
      const response = await this.api.list(cursor);
      if (!this.current(request, identity)) return;
      this.storedItems.update((items) => {
        const previous = reset ? [] : items;
        const seen = new Set(previous.map((item) => item.id));
        return [...previous, ...response.items.filter((item) => !seen.has(item.id))];
      });
      this.nextCursor.set(response.nextCursor);
    } catch {
      if (this.current(request, identity))
        this.listError.set(
          'Your inquiries could not be loaded. Check your connection and try again.'
        );
    } finally {
      if (this.current(request, identity)) this.loading.set(false);
    }
  }

  async update(inquiry: OwnerInquiry, status: InquiryStatus): Promise<void> {
    if (this.destroyed || this.loading() || this.busyId() || !this.session.user()) return;
    const request = this.request;
    const identity = this.session.identityVersion();
    this.busyId.set(inquiry.id);
    this.actionError.set('');
    this.notice.set('');
    try {
      const updated = await this.api.update(inquiry.id, { status });
      if (!this.current(request, identity)) return;
      this.storedItems.update((items) =>
        items.map((item) => (item.id === updated.id ? updated : item))
      );
      this.notice.set(`Inquiry marked as ${status}.`);
    } catch {
      if (this.current(request, identity))
        this.actionError.set(
          'We could not confirm this change. Try the action again to set its status.'
        );
    } finally {
      if (this.current(request, identity)) this.busyId.set(null);
    }
  }

  statusLabel(status: InquiryStatus): string {
    return status === 'unread' ? 'Unread' : status === 'read' ? 'Read' : 'Archived';
  }

  private current(request: number, identity: number): boolean {
    return (
      !this.destroyed && request === this.request && identity === this.session.identityVersion()
    );
  }
}
