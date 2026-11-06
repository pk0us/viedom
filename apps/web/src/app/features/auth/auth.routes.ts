import type { Routes } from '@angular/router';

export const authRoutes: Routes = [
  {
    path: 'login',
    title: 'Sign in · Viedom',
    loadComponent: () => import('./credentials-page').then((m) => m.CredentialsPage)
  },
  {
    path: 'register',
    title: 'Create an account · Viedom',
    data: { mode: 'register' },
    loadComponent: () => import('./credentials-page').then((m) => m.CredentialsPage)
  },
  {
    path: 'verification',
    title: 'Email verification · Viedom',
    data: { mode: 'verification' },
    loadComponent: () => import('./email-request-page').then((m) => m.EmailRequestPage)
  },
  {
    path: 'forgot-password',
    title: 'Forgot password · Viedom',
    loadComponent: () => import('./email-request-page').then((m) => m.EmailRequestPage)
  },
  {
    path: 'verify-email',
    title: 'Verify your email · Viedom',
    data: { mode: 'verification' },
    loadComponent: () => import('./email-action-page').then((m) => m.EmailActionPage)
  },
  {
    path: 'reset-password',
    title: 'Reset your password · Viedom',
    loadComponent: () => import('./email-action-page').then((m) => m.EmailActionPage)
  },
  {
    path: 'callback',
    title: 'Completing sign in · Viedom',
    loadComponent: () => import('./callback-page').then((m) => m.CallbackPage)
  }
];
