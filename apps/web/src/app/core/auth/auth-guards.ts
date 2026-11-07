import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { Router } from '@angular/router';
import { AuthSession } from './auth-session';

export function intendedRoute(value: string | null): string {
  return value && /^\/(?:owner|admin)(?:\/[a-zA-Z0-9_-]+)*$/.test(value) ? value : '/owner';
}

export const sessionGuard: CanActivateFn = async (_route, state) => {
  const session = inject(AuthSession);
  const router = inject(Router);
  try {
    if (await session.restore()) return true;
  } catch {
    /* The login page provides a retry when the session service is unavailable. */
  }
  return router.createUrlTree(['/auth/login'], {
    queryParams: { returnUrl: intendedRoute(state.url) }
  });
};

export const adminGuard: CanActivateFn = async (_route, state) => {
  const session = inject(AuthSession);
  const router = inject(Router);
  try {
    if (await session.restore()) {
      await session.reloadUser();
      return session.user()?.role === 'ADMIN' ? true : router.createUrlTree(['/owner']);
    }
  } catch {
    return router.createUrlTree(['/auth/login'], {
      queryParams: { returnUrl: intendedRoute(state.url) }
    });
  }
  return router.createUrlTree(['/auth/login'], {
    queryParams: { returnUrl: intendedRoute(state.url) }
  });
};
