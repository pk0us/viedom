import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { InquiriesClient } from '../inquiries-client';
import { InquiryForm } from './inquiry-form';

describe('public inquiry form', () => {
  const create = vi.fn();

  async function setup() {
    TestBed.configureTestingModule({
      providers: [{ provide: InquiriesClient, useValue: { create } }]
    });
    const fixture = TestBed.createComponent(InquiryForm);
    fixture.componentRef.setInput('listingId', 'first-home');
    await fixture.whenStable();
    return {
      fixture,
      page: fixture.componentInstance,
      element: fixture.nativeElement as HTMLElement
    };
  }

  function fill(element: HTMLElement, field: string, value: string): void {
    const input = element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[formControlName="${field}"]`
    )!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function valid(element: HTMLElement): void {
    fill(element, 'name', ' Visitor ');
    fill(element, 'email', 'visitor@example.test');
    fill(element, 'message', ' Is this home still available? ');
  }

  beforeEach(() => create.mockReset());

  it('validates and focuses the first invalid contact field before sending', async () => {
    const { fixture, page, element } = await setup();
    const focusName = vi.spyOn(element.querySelector<HTMLInputElement>('#inquiry-name')!, 'focus');
    await page.save();
    await fixture.whenStable();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('highlighted fields');
    expect(element.querySelector('#inquiry-name')?.getAttribute('aria-invalid')).toBe('true');
    expect(create).not.toHaveBeenCalled();
    expect(focusName).toHaveBeenCalledOnce();
    valid(element);
    fill(element, 'email', 'invalid-email');
    await page.save();
    await fixture.whenStable();
    expect(element.querySelector('#inquiry-email')?.getAttribute('aria-invalid')).toBe('true');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects unsupported phone characters before requesting the server', async () => {
    const { fixture, page, element } = await setup();
    valid(element);
    fill(element, 'phone', 'call me tomorrow');
    await page.save();
    await fixture.whenStable();
    expect(element.querySelector('#inquiry-phone')?.getAttribute('aria-invalid')).toBe('true');
    expect(create).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions, preserves values after throttling and announces success', async () => {
    const { fixture, page, element } = await setup();
    valid(element);
    let reject!: (reason: unknown) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const first = page.save();
    await page.save();
    await fixture.whenStable();
    expect(create).toHaveBeenCalledOnce();
    expect(element.querySelector('fieldset')?.disabled).toBe(true);
    expect(element.textContent).toContain('Sending your inquiry');
    reject(
      new HttpErrorResponse({ status: 429, headers: new HttpHeaders({ 'Retry-After': '30' }) })
    );
    await first;
    await fixture.whenStable();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('30 seconds');
    expect(page.form.controls.message.value).toBe('Is this home still available?');
    create.mockResolvedValueOnce({ id: 'receipt' });
    await page.save();
    await fixture.whenStable();
    expect(create).toHaveBeenLastCalledWith('first-home', {
      name: 'Visitor',
      email: 'visitor@example.test',
      message: 'Is this home still available?',
      website: ''
    });
    expect(element.querySelector('[role="status"]')?.textContent).toContain(
      'Your inquiry was sent'
    );
    expect(element.querySelector('form')).toBeNull();
  });

  it('clears contact data on listing change and ignores a late success for the previous home', async () => {
    const { fixture, page, element } = await setup();
    valid(element);
    let resolve!: (value: unknown) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const sending = page.save();
    fixture.componentRef.setInput('listingId', 'second-home');
    await fixture.whenStable();
    expect(page.form.controls.email.value).toBe('');
    expect(page.busy()).toBe(false);
    resolve({ id: 'old-receipt' });
    await sending;
    await fixture.whenStable();
    expect(page.sent()).toBe(false);
    expect(element.textContent).not.toContain('Your inquiry was sent');
  });

  it('shows a safe unavailable message and retains contact fields when eligibility changes', async () => {
    const { fixture, page, element } = await setup();
    valid(element);
    create.mockRejectedValueOnce(new HttpErrorResponse({ status: 404 }));
    await page.save();
    await fixture.whenStable();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('no longer available');
    expect(page.form.controls.email.value).toBe('visitor@example.test');
  });
});
