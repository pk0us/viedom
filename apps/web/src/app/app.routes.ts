import type { Routes } from '@angular/router';
import { adminGuard, sessionGuard } from './core/auth/auth-guards';

export const routes: Routes = [
  {
    path: 'admin',
    canActivate: [adminGuard],
    canActivateChild: [adminGuard],
    data: { noindex: true },
    loadComponent: () => import('./features/admin/admin-layout').then((m) => m.AdminLayout),
    children: [
      {
        path: '',
        pathMatch: 'full',
        redirectTo: 'listings'
      },
      {
        path: 'listings',
        title: 'Pending review · Viedom',
        loadComponent: () =>
          import('./features/admin/admin-moderation').then((m) => m.AdminModeration)
      },
      {
        path: 'listings/:id',
        title: 'Review listing · Viedom',
        loadComponent: () =>
          import('./features/admin/admin-moderation').then((m) => m.AdminModeration)
      }
    ]
  },
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
        path: 'search',
        title: 'Find a home · Viedom',
        loadComponent: () => import('./features/search/search-page').then((m) => m.SearchPage)
      },
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
