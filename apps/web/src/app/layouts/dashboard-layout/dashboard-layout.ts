import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SessionControls } from '../../core/auth/session-controls';

@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet, SessionControls],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-dashboard-layout',
  styleUrl: './dashboard-layout.scss',
  templateUrl: './dashboard-layout.html'
})
export class DashboardLayout {}
