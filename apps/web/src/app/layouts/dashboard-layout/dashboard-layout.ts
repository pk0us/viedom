import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-dashboard-layout',
  styleUrl: './dashboard-layout.scss',
  templateUrl: './dashboard-layout.html'
})
export class DashboardLayout {}
