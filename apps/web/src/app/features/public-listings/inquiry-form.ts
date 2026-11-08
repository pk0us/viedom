import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  signal
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { actionError } from '../auth/auth-feedback';
import { InquiriesClient } from '../inquiries-client';

@Component({
  selector: 'app-inquiry-form',
  imports: [ReactiveFormsModule, NzButtonModule, NzInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inquiry-form.html',
  styleUrl: './inquiry-form.scss'
})
export class InquiryForm {
  readonly listingId = input.required<string>();
  private readonly api = inject(InquiriesClient);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private request = 0;
  private destroyed = false;
  readonly busy = signal(false);
  readonly sent = signal(false);
  readonly error = signal('');
  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(100)]
    }),
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email, Validators.maxLength(254)]
    }),
    phone: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(32), Validators.pattern(/^[+()0-9 .-]+$/)]
    }),
    message: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(10), Validators.maxLength(4000)]
    }),
    website: new FormControl('', { nonNullable: true })
  });

  constructor() {
    effect(() => {
      this.listingId();
      this.request++;
      this.form.reset();
      this.busy.set(false);
      this.sent.set(false);
      this.error.set('');
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.request++;
    });
  }

  invalid(field: 'name' | 'email' | 'phone' | 'message'): boolean {
    const control = this.form.controls[field];
    return control.touched && control.invalid;
  }

  async save(): Promise<void> {
    if (this.busy() || this.sent()) return;
    const values = this.form.getRawValue();
    this.form.patchValue({
      name: values.name.trim(),
      email: values.email.trim(),
      phone: values.phone.trim(),
      message: values.message.trim()
    });
    this.form.markAllAsTouched();
    this.error.set('');
    if (this.form.invalid) {
      this.error.set('Please check the highlighted fields.');
      const first = (['name', 'email', 'phone', 'message'] as const).find((field) =>
        this.invalid(field)
      );
      this.element.nativeElement
        .querySelector<HTMLElement>(`[formControlName="${first}"]`)
        ?.focus();
      return;
    }
    const listingId = this.listingId();
    const request = ++this.request;
    this.busy.set(true);
    try {
      const body = this.form.getRawValue();
      await this.api.create(listingId, {
        name: body.name,
        email: body.email,
        ...(body.phone ? { phone: body.phone } : {}),
        message: body.message,
        website: body.website
      });
      if (!this.current(request, listingId)) return;
      this.form.reset();
      this.sent.set(true);
    } catch (error) {
      if (!this.current(request, listingId)) return;
      this.error.set(
        error instanceof HttpErrorResponse && error.status === 404
          ? 'This home is no longer available for inquiries. Explore other homes.'
          : actionError(error, 'Your inquiry could not be sent. Check your details and try again.')
      );
    } finally {
      if (this.current(request, listingId)) this.busy.set(false);
    }
  }

  private current(request: number, listingId: string): boolean {
    return !this.destroyed && request === this.request && listingId === this.listingId();
  }
}
