import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SessionControls } from '../../core/auth/session-controls';
import { AuthSession } from '../../core/auth/auth-session';

@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet, SessionControls],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-dashboard-layout',
  styleUrl: './dashboard-layout.scss',
  templateUrl: './dashboard-layout.html'
})
export class DashboardLayout {
  readonly session = inject(AuthSession);
}
