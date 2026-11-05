import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormField, form, required } from '@angular/forms/signals';
import { FieldFeedback } from './field-feedback';

// A test-only form establishes the shared convention without shipping a future feature.
@Component({
  imports: [FormField, FieldFeedback],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="form-field">
    <label for="name">Name (required)</label>
    <input
      id="name"
      [formField]="fields.name"
      aria-describedby="name-feedback"
      [attr.aria-invalid]="invalid() ? 'true' : null"
    />
    <app-field-feedback
      feedbackId="name-feedback"
      hint="Enter your name."
      [errors]="messages()"
      [showErrors]="invalid()"
    />
  </div>`
})
class FormExample {
  readonly model = signal({ name: '' });
  readonly fields = form(this.model, (path) =>
    required(path.name, { message: 'Name is required.' })
  );
  readonly invalid = computed(() => this.fields.name().touched() && this.fields.name().invalid());
  readonly messages = computed(() =>
    this.fields
      .name()
      .errors()
      .map((error) => error.message ?? 'Check this value.')
  );
}

describe('accessible Signal Forms feedback convention', () => {
  it('reveals errors after blur and clears them after correction', async () => {
    const fixture = TestBed.createComponent(FormExample);
    await fixture.whenStable();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(fixture.nativeElement.textContent).toContain('Enter your name.');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'Name is required.'
    );
    input.value = 'Alex';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });
});
