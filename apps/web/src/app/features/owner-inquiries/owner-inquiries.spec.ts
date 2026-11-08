import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { OwnerInquiry } from '@viedom/contracts';
import { AuthSession } from '../../core/auth/auth-session';
import { InquiriesClient } from '../inquiries-client';
import { OwnerInquiries } from './owner-inquiries';

const inquiry: OwnerInquiry = {
  id: 'first-inquiry',
  listingId: 'home',
  listingTitle: 'Sunny home',
  name: 'Visitor',
  email: 'visitor@example.test',
  phone: '+30 210 1234567',
  message: '<script>private message</script>',
  status: 'unread',
  createdAt: '2026-11-08T12:00:00.000Z'
};

describe('publisher inquiry inbox', () => {
  const list = vi.fn();
  const update = vi.fn();
  const user = signal<{ id: string } | null>({ id: 'owner' });
  let identity = 0;

  async function setup() {
    TestBed.configureTestingModule({
      providers: [
        { provide: InquiriesClient, useValue: { list, update } },
        { provide: AuthSession, useValue: { user, identityVersion: () => identity } }
      ]
    });
    const fixture = TestBed.createComponent(OwnerInquiries);
    await fixture.whenStable();
    return {
      fixture,
      page: fixture.componentInstance,
      element: fixture.nativeElement as HTMLElement
    };
  }

  beforeEach(() => {
    user.set({ id: 'owner' });
    identity = 0;
    list.mockReset().mockResolvedValue({ items: [inquiry], nextCursor: null });
    update.mockReset();
  });

  it('loads private contacts, escapes messages and supports read, archive and unread states', async () => {
    const { fixture, page, element } = await setup();
    expect(list).toHaveBeenCalledOnce();
    expect(element.querySelector('h1')?.textContent).toBe('Inquiries');
    expect(element.textContent).toContain('visitor@example.test');
    expect(element.textContent).toContain('+30 210 1234567');
    expect(element.querySelector('.message')?.textContent).toContain('<script>');
    expect(element.querySelector('script')).toBeNull();
    expect(element.querySelector('a')).toBeNull();
    for (const status of ['read', 'archived', 'unread'] as const) {
      update.mockResolvedValueOnce({ ...inquiry, status });
      await page.update(page.items()[0]!, status);
      await fixture.whenStable();
      expect(update).toHaveBeenLastCalledWith(inquiry.id, { status });
      expect(page.items()[0]?.status).toBe(status);
      expect(element.querySelector('[role="status"]')?.textContent).toContain(status);
    }
  });

  it('shows retry and empty states, and preserves pagination when a later page fails', async () => {
    list.mockRejectedValueOnce(new Error('offline'));
    const { fixture, page, element } = await setup();
    expect(element.textContent).toContain('We could not load your inquiries');
    list.mockResolvedValueOnce({ items: [], nextCursor: null });
    element.querySelector<HTMLButtonElement>('app-ui-state button')!.click();
    await fixture.whenStable();
    expect(element.textContent).toContain('No inquiries yet');
    list.mockResolvedValueOnce({ items: [inquiry], nextCursor: 'next-page' });
    await page.load(true);
    list.mockRejectedValueOnce(new Error('offline'));
    await page.load();
    await fixture.whenStable();
    expect(page.items()).toEqual([inquiry]);
    expect(page.nextCursor()).toBe('next-page');
    list.mockResolvedValueOnce({
      items: [inquiry, { ...inquiry, id: 'second-inquiry' }],
      nextCursor: null
    });
    element.querySelector<HTMLButtonElement>('app-ui-state button')!.click();
    await fixture.whenStable();
    expect(list).toHaveBeenLastCalledWith('next-page');
    expect(page.items().map((item) => item.id)).toEqual(['first-inquiry', 'second-inquiry']);
  });

  it('announces failed status changes, keeps original state and prevents duplicate actions', async () => {
    const { fixture, page, element } = await setup();
    let reject!: (reason: unknown) => void;
    update.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const work = page.update(inquiry, 'archived');
    await page.update(inquiry, 'read');
    await fixture.whenStable();
    expect(update).toHaveBeenCalledOnce();
    expect(element.querySelector('button')?.disabled).toBe(true);
    reject(new Error('unavailable'));
    await work;
    await fixture.whenStable();
    expect(page.items()[0]?.status).toBe('unread');
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('could not confirm');
  });

  it('clears private data on sign-out and ignores an outstanding page response', async () => {
    const { fixture, page, element } = await setup();
    let resolve!: (value: unknown) => void;
    list.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const work = page.load(true);
    identity++;
    user.set(null);
    await fixture.whenStable();
    resolve({ items: [inquiry], nextCursor: 'private-cursor' });
    await work;
    await fixture.whenStable();
    expect(page.items()).toEqual([]);
    expect(page.nextCursor()).toBeNull();
    expect(element.textContent).not.toContain('visitor@example.test');
  });

  it('replaces private data when another account becomes active', async () => {
    const { fixture, page, element } = await setup();
    list.mockResolvedValueOnce({ items: [], nextCursor: null });
    identity++;
    user.set({ id: 'another-owner' });
    await fixture.whenStable();
    expect(list).toHaveBeenCalledTimes(2);
    expect(page.items()).toEqual([]);
    expect(element.textContent).not.toContain('visitor@example.test');
  });
});
