import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { isPlatformServer } from '@angular/common';
import { Injectable, PLATFORM_ID, TransferState, inject, makeStateKey } from '@angular/core';
import type { PublicListingDetail, RecentListingsResponse } from '@viedom/contracts';
import { catchError, of, tap, throwError } from 'rxjs';
import { API_BASE_URL } from '../../health/health-client';

type PublicSnapshot<T> = { value: T } | { status: 404 | 503 };

@Injectable({ providedIn: 'root' })
export class PublicListingsClient {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL).replace(/\/$/, '');
  private readonly transferState = inject(TransferState);
  private readonly server = isPlatformServer(inject(PLATFORM_ID));

  recent() {
    return this.publicSnapshot<RecentListingsResponse>('recent', `${this.base}/listings/recent`);
  }

  read(id: string) {
    return this.publicSnapshot<PublicListingDetail>(
      id,
      `${this.base}/listings/${encodeURIComponent(id)}`
    );
  }

  private publicSnapshot<T>(identity: string, url: string) {
    const key = makeStateKey<PublicSnapshot<T> | null>(`viedom:public-listings:${identity}`);
    if (!this.server && this.transferState.hasKey(key)) {
      const snapshot = this.transferState.get(key, null);
      this.transferState.remove(key);
      if (snapshot !== null) {
        return 'value' in snapshot
          ? of(snapshot.value)
          : throwError(() => new HttpErrorResponse({ status: snapshot.status }));
      }
    }
    return this.http
      .get<T>(url, {
        credentials: 'omit',
        timeout: 10000,
        transferCache: false
      })
      .pipe(
        tap((snapshot) => {
          if (this.server) this.transferState.set(key, { value: snapshot });
        }),
        catchError((error: unknown) => {
          if (this.server) {
            const status = error instanceof HttpErrorResponse && error.status === 404 ? 404 : 503;
            this.transferState.set(key, { status });
          }
          return throwError(() => error);
        })
      );
  }
}
