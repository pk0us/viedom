import { HttpErrorResponse } from '@angular/common/http';
import { SessionCoordinationError } from '../../core/auth/auth-session';

interface FeedbackState {
  touched(): boolean;
  invalid(): boolean;
  errors(): readonly { message?: string }[];
}

export function invalid(field: FeedbackState): boolean {
  return field.touched() && field.invalid();
}

export function messages(field: FeedbackState): string[] {
  return field.errors().map((error) => error.message ?? 'Check this value.');
}

export function actionError(error: unknown, fallback: string): string {
  if (error instanceof SessionCoordinationError)
    return 'Your browser cannot coordinate secure sessions. Use a current browser over HTTPS or localhost.';
  if (error instanceof HttpErrorResponse) {
    if (error.status === 429) {
      const seconds = Number(error.headers.get('Retry-After'));
      return Number.isFinite(seconds) && seconds > 0 && seconds <= 900
        ? `Too many attempts. Please try again in ${Math.ceil(seconds)} seconds.`
        : 'Too many attempts. Please wait a few minutes before trying again.';
    }
    if (error.status === 0 || error.status >= 500)
      return 'The service is unavailable. Please try again shortly.';
  }
  return fallback;
}
