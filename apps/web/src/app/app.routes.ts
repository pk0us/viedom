import type { Routes } from '@angular/router';

export const routes: Routes = [
  // Reserved and fail-closed until server authorization and admin UI exist.
  { path: 'admin', canMatch: [() => false], children: [] },
  {
    path: 'owner',
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
