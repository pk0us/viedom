import type { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./health/health-page').then((m) => m.HealthPage) }
];
