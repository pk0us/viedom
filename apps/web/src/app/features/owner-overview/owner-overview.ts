import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { AuthSession } from '../../core/auth/auth-session';
import { UiState } from '../../shared/ui-state/ui-state';

@Component({
  imports: [UiState, RouterLink, NzButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-owner-overview',
  styleUrl: './owner-overview.scss',
  templateUrl: './owner-overview.html'
})
export class OwnerOverview {
  readonly session = inject(AuthSession);
  readonly checking = signal(false);
  readonly error = signal(false);
  async checkAccount(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    this.error.set(false);
    try {
      await this.session.reloadUser();
    } catch {
      this.error.set(true);
    } finally {
      this.checking.set(false);
    }
  }
}
