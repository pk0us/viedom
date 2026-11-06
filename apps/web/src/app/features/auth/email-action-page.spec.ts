import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { AuthSession } from '../../core/auth/auth-session';
import { EmailActionPage } from './email-action-page';

describe('email link handling', () => {
  const first = 'A'.repeat(43);
  const second = 'B'.repeat(43);
  let fragment: Subject<string | null>;
  let confirmEmail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fragment = new Subject();
    confirmEmail = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthSession, useValue: { confirmEmail } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { data: { mode: 'verification' } }, fragment }
        }
      ]
    });
    window.history.replaceState({}, '', `/auth/verify-email#token=${first}`);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    window.history.replaceState({}, '', '/');
  });

  it('scrubs a new same-document link without confirming until the user acts', async () => {
    const fixture = TestBed.createComponent(EmailActionPage);
    const page = fixture.componentInstance;
    expect(window.location.hash).toBe('');
    expect(page.available()).toBe(true);
    expect(confirmEmail).not.toHaveBeenCalled();
    await page.confirm();
    expect(confirmEmail).toHaveBeenLastCalledWith(first);
    expect(page.complete()).toBe(true);

    window.history.pushState({}, '', `/auth/verify-email#token=${second}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('');
    expect(page.complete()).toBe(false);
    expect(confirmEmail).toHaveBeenCalledTimes(1);
    fragment.next(null);
    expect(page.available()).toBe(true);
    await page.confirm();
    expect(confirmEmail).toHaveBeenLastCalledWith(second);
  });

  it('scrubs invalid links and removes the hash listener when destroyed', () => {
    const fixture = TestBed.createComponent(EmailActionPage);
    window.history.pushState({}, '', '/auth/verify-email#token=bad');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('');
    expect(fixture.componentInstance.available()).toBe(false);
    expect(confirmEmail).not.toHaveBeenCalled();
    fixture.destroy();
    window.history.pushState({}, '', `/auth/verify-email#token=${second}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe(`#token=${second}`);
  });
});
