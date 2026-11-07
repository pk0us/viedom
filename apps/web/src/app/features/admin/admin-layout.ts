import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { SessionControls } from '../../core/auth/session-controls';

@Component({
  selector: 'app-admin-layout',
  imports: [RouterLink, RouterOutlet, SessionControls],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../../layouts/dashboard-layout/dashboard-layout.scss',
  template: `
    <header class="workspace-header">
      <a class="wordmark" routerLink="/">viedom</a><span>Administrator workspace</span>
      <a class="back-link" routerLink="/owner">My listings</a><app-session-controls />
    </header>
    <div class="workspace-body">
      <aside>
        <p class="eyebrow">Moderation</p>
        <nav aria-label="Administrator navigation">
          <a routerLink="/admin/listings" class="active" aria-current="page">Pending review</a>
        </nav>
        <p class="sidebar-note">Private review information is restricted to administrators.</p>
      </aside>
      <main id="main-content" tabindex="-1"><router-outlet /></main>
    </div>
  `
})
export class AdminLayout {}
