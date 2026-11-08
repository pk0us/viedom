import { HttpErrorResponse } from '@angular/common/http';
import { inject, RESPONSE_INIT } from '@angular/core';
import { RedirectCommand, Router } from '@angular/router';
import type { ResolveFn } from '@angular/router';
import type { PublicListingDetail } from '@viedom/contracts';
import { catchError, map, of } from 'rxjs';
import { PublicListingsClient } from '../features/public-listings/public-listings-client';

export interface PublicListingResult {
  listing: PublicListingDetail | null;
  unavailable: boolean;
}

export const publicListingResolver: ResolveFn<PublicListingResult | RedirectCommand> = (route) => {
  const client = inject(PublicListingsClient);
  const router = inject(Router);
  const response = inject(RESPONSE_INIT, { optional: true });
  const id = route.paramMap.get('id') ?? '';
  if (!/^[a-f0-9]{24}$/.test(id)) {
    if (response) response.status = 404;
    return { listing: null, unavailable: false };
  }
  return client.read(id).pipe(
    map((listing) => {
      if (route.paramMap.get('slug') !== listing.slug) {
        const destination = router.createUrlTree(['/listings', listing.id, listing.slug]);
        if (!response) return new RedirectCommand(destination, { replaceUrl: true });
        response.status = 301;
        const headers = new Headers(response.headers);
        headers.set('Location', router.serializeUrl(destination));
        response.headers = headers;
      }
      return { listing, unavailable: false };
    }),
    catchError((error: unknown) => {
      const missing = error instanceof HttpErrorResponse && error.status === 404;
      if (response) response.status = missing ? 404 : 503;
      return of({ listing: null, unavailable: !missing });
    })
  );
};
