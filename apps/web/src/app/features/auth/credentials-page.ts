import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  FormField,
  form,
  required,
  email,
  minLength,
  maxLength,
  pattern,
  validate,
  submit
} from '@angular/forms/signals';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { AuthSession } from '../../core/auth/auth-session';
import { intendedRoute } from '../../core/auth/auth-guards';
import { FieldFeedback } from '../../shared/field-feedback/field-feedback';
import { actionError, invalid, messages } from './auth-feedback';

@Component({
  imports: [FormField, RouterLink, NzButtonModule, FieldFeedback],
  selector: 'app-credentials-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './credentials-page.scss',
  templateUrl: './credentials-page.html'
})
export class CredentialsPage {
  private readonly session = inject(AuthSession);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly document = inject(DOCUMENT);
  readonly registering = this.route.snapshot.data['mode'] === 'register';
  readonly returnUrl = intendedRoute(this.route.snapshot.queryParamMap.get('returnUrl'));
  readonly busy = signal(false);
  readonly error = signal('');
  readonly created = signal(false);
  readonly mailSent = signal(false);
  readonly invalid = invalid;
  readonly messages = messages;
  readonly model = signal({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmation: ''
  });
  readonly fields = form(this.model, (path) => {
    required(path.email, { message: 'Enter your email address.' });
    email(path.email, { message: 'Enter a valid email address.' });
    maxLength(path.email, 254, { message: 'Use an email address of at most 254 characters.' });
    required(path.password, { message: 'Enter your password.' });
    minLength(path.password, 12, {
      when: () => this.registering,
      message: 'Use at least 12 characters.'
    });
    maxLength(path.password, 128, { message: 'Use at most 128 characters.' });
    for (const name of [path.firstName, path.lastName]) {
      required(name, { when: () => this.registering, message: 'Enter your name.' });
      pattern(name, /\S/, { when: () => this.registering, message: 'Enter your name.' });
      maxLength(name, 100, { message: 'Use at most 100 characters.' });
    }
    required(path.confirmation, { when: () => this.registering, message: 'Repeat your password.' });
    validate(path.confirmation, ({ value, valueOf }) =>
      this.registering && value() !== valueOf(path.password)
        ? { kind: 'mismatch', message: 'The passwords must match.' }
        : undefined
    );
  });

  async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.error.set('');
    await submit(this.fields, async () => {
      this.busy.set(true);
      try {
        const value = this.model();
        if (this.registering) {
          await this.session.register({
            firstName: value.firstName.trim(),
            lastName: value.lastName.trim(),
            email: value.email.trim(),
            password: value.password
          });
          this.created.set(true);
          this.model.update((model) => ({ ...model, password: '', confirmation: '' }));
          await this.sendVerification();
        } else {
          await this.session.login({ email: value.email.trim(), password: value.password });
          await this.router.navigateByUrl(this.returnUrl);
        }
      } catch (error) {
        this.error.set(
          actionError(
            error,
            this.registering
              ? 'We could not create this account. Try signing in or use another email address.'
              : 'Sign in failed. Check your email and password and try again.'
          )
        );
      } finally {
        this.busy.set(false);
      }
    });
    if (!this.created() && this.fields().invalid()) {
      this.error.set('Please check the highlighted fields.');
      [
        this.fields.firstName,
        this.fields.lastName,
        this.fields.email,
        this.fields.password,
        this.fields.confirmation
      ]
        .find((field) => field().invalid())?.()
        .focusBoundControl();
    }
  }

  async resend(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    await this.sendVerification();
    this.busy.set(false);
  }

  private async sendVerification(): Promise<void> {
    try {
      await this.session.requestVerification(this.model().email.trim());
      this.mailSent.set(true);
    } catch (error) {
      this.error.set(
        actionError(
          error,
          'Your account was created, but we could not request the verification email. Please try again.'
        )
      );
    }
  }

  async google(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const url = await this.session.googleStart();
      this.document.defaultView?.location.assign(url);
    } catch (error) {
      this.error.set(
        actionError(
          error,
          'Google sign in could not start. Please try again or sign in with your password.'
        )
      );
      this.busy.set(false);
    }
  }
}
