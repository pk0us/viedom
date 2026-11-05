import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-field-feedback',
  styleUrl: './field-feedback.scss',
  templateUrl: './field-feedback.html'
})
export class FieldFeedback {
  // Set aria-describedby on the control to this id. Never put sensitive values in messages.
  readonly feedbackId = input.required<string>();
  readonly hint = input('');
  readonly errors = input<readonly string[]>([]);
  readonly showErrors = input(false);
}
