import type { Routes } from '@angular/router';
import { sessionGuard } from './core/auth/auth-guards';

export const routes: Routes = [
  // Reserved and fail-closed until server authorization and admin UI exist.
  { path: 'admin', canMatch: [() => false], children: [] },
  {
    path: 'owner',
    canActivate: [sessionGuard],
    canActivateChild: [sessionGuard],
    data: { noindex: true },
    loadComponent: () =>
      import('./layouts/dashboard-layout/dashboard-layout').then((m) => m.DashboardLayout),
    loadChildren: () => import('./features/owner.routes').then((m) => m.ownerRoutes)
  },
  {
    path: '',
    loadComponent: () =>
      import('./layouts/public-layout/public-layout').then((m) => m.PublicLayout),
    children: [
      {
        path: 'auth',
        data: { noindex: true },
        loadChildren: () => import('./features/auth/auth.routes').then((m) => m.authRoutes)
      },
      {
        path: '',
        pathMatch: 'full',
        title: 'Viedom · Your place in Thessaloniki',
        loadComponent: () =>
          import('./features/welcome-page/welcome-page').then((m) => m.WelcomePage)
      },
      {
        path: 'health',
        title: 'Service status · Viedom',
        data: { noindex: true },
        loadComponent: () => import('./health/health-page').then((m) => m.HealthPage)
      },
      {
        path: '**',
        title: 'Page not found · Viedom',
        data: { noindex: true },
        loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFound)
      }
    ]
  }
];
