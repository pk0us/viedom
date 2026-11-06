import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  FormField,
  form,
  required,
  minLength,
  maxLength,
  validate,
  submit
} from '@angular/forms/signals';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { AuthSession } from '../../core/auth/auth-session';
import { FieldFeedback } from '../../shared/field-feedback/field-feedback';
import { actionError, invalid, messages } from './auth-feedback';

@Component({
  imports: [FormField, RouterLink, NzButtonModule, FieldFeedback],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-email-action-page',
  styleUrl: './email-action-page.scss',
  templateUrl: './email-action-page.html'
})
export class EmailActionPage {
  private readonly session = inject(AuthSession);
  private readonly document = inject(DOCUMENT);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private token = '';
  private generation = 0;
  readonly verification = this.route.snapshot.data['mode'] === 'verification';
  readonly available = signal(false);
  readonly busy = signal(false);
  readonly complete = signal(false);
  readonly error = signal('');
  readonly invalid = invalid;
  readonly messages = messages;
  readonly model = signal({ password: '', confirmation: '' });
  readonly fields = form(this.model, (path) => {
    required(path.password, { message: 'Enter a new password.' });
    minLength(path.password, 12, { message: 'Use at least 12 characters.' });
    maxLength(path.password, 128, { message: 'Use at most 128 characters.' });
    required(path.confirmation, { message: 'Repeat your new password.' });
    validate(path.confirmation, ({ value, valueOf }) =>
      value() !== valueOf(path.password)
        ? { kind: 'mismatch', message: 'The passwords must match.' }
        : undefined
    );
  });

  constructor() {
    const browser = this.document.defaultView;
    if (!browser) return;
    const captureHash = () => this.capture(browser.location.hash.slice(1));
    captureHash();
    const subscription = this.route.fragment.subscribe((fragment) => this.capture(fragment));
    browser.addEventListener('hashchange', captureHash);
    this.destroyRef.onDestroy(() => {
      subscription.unsubscribe();
      browser.removeEventListener('hashchange', captureHash);
      this.token = '';
      this.generation++;
    });
  }

  private capture(value: string | null): void {
    if (!value) return;
    const browser = this.document.defaultView;
    if (!browser) return;
    const fragment = new URLSearchParams(value);
    const candidate = fragment.get('token') ?? '';
    browser.history.replaceState(
      browser.history.state,
      '',
      browser.location.pathname + browser.location.search
    );
    this.generation++;
    this.token = '';
    this.available.set(false);
    this.complete.set(false);
    this.error.set('');
    this.model.set({ password: '', confirmation: '' });
    if (/^[A-Za-z0-9_-]{43}$/.test(candidate)) {
      this.token = candidate;
      this.available.set(true);
    }
  }

  async confirm(): Promise<void> {
    if (this.busy() || !this.available() || this.complete()) return;
    this.busy.set(true);
    this.error.set('');
    const generation = this.generation;
    try {
      await this.session.confirmEmail(this.token);
      if (generation !== this.generation) return;
      this.token = '';
      this.complete.set(true);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error.set(
        actionError(
          error,
          'This verification link is invalid or has expired. Request a new email and use its latest link.'
        )
      );
    } finally {
      this.busy.set(false);
    }
  }

  async reset(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !this.available() || this.complete()) return;
    this.error.set('');
    await submit(this.fields, async () => {
      this.busy.set(true);
      const generation = this.generation;
      try {
        await this.session.resetPassword(this.token, this.model().password);
        if (generation !== this.generation) return;
        this.token = '';
        this.model.set({ password: '', confirmation: '' });
        this.complete.set(true);
      } catch (error) {
        if (generation !== this.generation) return;
        this.error.set(
          actionError(
            error,
            'This reset link is invalid or has expired. Request a new email and use its latest link.'
          )
        );
      } finally {
        this.busy.set(false);
      }
    });
    if (!this.complete() && this.fields().invalid()) {
      this.error.set('Please check the highlighted fields.');
      (this.fields.password().invalid()
        ? this.fields.password()
        : this.fields.confirmation()
      ).focusBoundControl();
    }
  }
}
