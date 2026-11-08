import type { Routes } from '@angular/router';
import { unsavedListingGuard } from './unsaved-listing-guard';

export const ownerRoutes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'My listings · Viedom',
    loadComponent: () => import('./owner-overview/owner-overview').then((m) => m.OwnerOverview)
  },
  {
    path: 'inquiries',
    title: 'Inquiries · Viedom',
    loadComponent: () => import('./owner-inquiries/owner-inquiries').then((m) => m.OwnerInquiries)
  },
  {
    path: 'listings/new',
    title: 'New listing · Viedom',
    canDeactivate: [unsavedListingGuard],
    loadComponent: () => import('./listing-editor/listing-editor').then((m) => m.ListingEditor)
  },
  {
    path: 'listings/:id',
    title: 'Edit listing · Viedom',
    canDeactivate: [unsavedListingGuard],
    runGuardsAndResolvers: 'paramsChange',
    loadComponent: () => import('./listing-editor/listing-editor').then((m) => m.ListingEditor)
  },
  {
    path: '**',
    title: 'Page not found · Viedom',
    loadComponent: () => import('./not-found/not-found').then((m) => m.NotFound)
  }
];
