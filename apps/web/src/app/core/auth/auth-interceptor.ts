import { HttpContextToken, HttpErrorResponse } from '@angular/common/http';
import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { publicConfig } from '../../../generated/public-config';
import { AuthSession } from './auth-session';

export const skipAuthRetry = new HttpContextToken(() => false);

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const base = publicConfig.apiBaseUrl.replace(/\/$/, '');
  if (
    !request.url.startsWith(`${base}/`) ||
    /^\/(auth|health)(\/|$)/.test(request.url.slice(base.length)) ||
    /^\/listings\/(search|markers)$/.test(request.url.slice(base.length))
  )
    return next(request);
  const session = inject(AuthSession);
  const generation = session.identityVersion();
  return from(session.token()).pipe(
    switchMap((token) => {
      if (generation !== session.identityVersion())
        return throwError(() => new HttpErrorResponse({ status: 401 }));
      const authorized = (value: string) =>
        request.clone({
          setHeaders: value ? { Authorization: `Bearer ${value}` } : {},
          transferCache: false
        });
      return next(authorized(token)).pipe(
        catchError((error: unknown) => {
          if (
            !(error instanceof HttpErrorResponse) ||
            error.status !== 401 ||
            !token ||
            request.context.get(skipAuthRetry)
          )
            return throwError(() => error);
          return from(session.renew(token, generation)).pipe(
            switchMap((renewed) =>
              renewed && generation === session.identityVersion()
                ? next(authorized(renewed)).pipe(
                    catchError((retryError: unknown) => {
                      if (retryError instanceof HttpErrorResponse && retryError.status === 401)
                        session.invalidate(renewed);
                      return throwError(() => retryError);
                    })
                  )
                : throwError(() => error)
            )
          );
        })
      );
    })
  );
};
