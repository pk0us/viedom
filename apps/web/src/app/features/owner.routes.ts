import type { Routes } from '@angular/router';

export const ownerRoutes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Owner workspace preview · Viedom',
    loadComponent: () => import('./owner-overview/owner-overview').then((m) => m.OwnerOverview)
  },
  {
    path: '**',
    title: 'Page not found · Viedom',
    loadComponent: () => import('./not-found/not-found').then((m) => m.NotFound)
  }
];
