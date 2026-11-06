import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormField, form, required, email, maxLength, submit } from '@angular/forms/signals';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { AuthSession } from '../../core/auth/auth-session';
import { FieldFeedback } from '../../shared/field-feedback/field-feedback';
import { actionError, invalid, messages } from './auth-feedback';

@Component({
  imports: [FormField, RouterLink, NzButtonModule, FieldFeedback],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-email-request-page',
  styleUrl: './email-request-page.scss',
  templateUrl: './email-request-page.html'
})
export class EmailRequestPage {
  private readonly session = inject(AuthSession);
  readonly verification = inject(ActivatedRoute).snapshot.data['mode'] === 'verification';
  readonly busy = signal(false);
  readonly error = signal('');
  readonly sent = signal(false);
  readonly invalid = invalid;
  readonly messages = messages;
  readonly model = signal({ email: this.verification ? (this.session.user()?.email ?? '') : '' });
  readonly fields = form(this.model, (path) => {
    required(path.email, { message: 'Enter your email address.' });
    email(path.email, { message: 'Enter a valid email address.' });
    maxLength(path.email, 254, { message: 'Use an email address of at most 254 characters.' });
  });

  async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.error.set('');
    this.sent.set(false);
    await submit(this.fields, async () => {
      this.busy.set(true);
      try {
        if (this.verification) await this.session.requestVerification(this.model().email.trim());
        else await this.session.forgotPassword(this.model().email.trim());
        this.sent.set(true);
      } catch (error) {
        this.error.set(actionError(error, 'We could not request an email. Please try again.'));
      } finally {
        this.busy.set(false);
      }
    });
    if (this.fields().invalid()) {
      this.error.set('Please check the highlighted field.');
      this.fields.email().focusBoundControl();
    }
  }
}
