import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { AuthSession } from './auth-session';

@Component({
  selector: 'app-session-controls',
  imports: [NzButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button nz-button type="button" [disabled]="busy()" [nzLoading]="busy()" (click)="logout()">
      <span>Log out</span>
    </button>
    @if (busy()) {
      <span role="status">Logging out…</span>
    }
    @if (error()) {
      <p role="alert">Logout could not be completed. Please try again.</p>
    }
  `
})
export class SessionControls {
  private readonly session = inject(AuthSession);
  readonly busy = signal(false);
  readonly error = signal(false);
  async logout(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(false);
    try {
      await this.session.logout();
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
}
