import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpContext, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { firstValueFrom, fromEvent, takeUntil } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AdminDecisionResponse,
  AdminListingDetail,
  AdminListingsResponse
} from '@viedom/contracts';
import { publicConfig } from '../../../generated/public-config';
import { AuthSession } from '../../core/auth/auth-session';
import { skipAuthRetry } from '../../core/auth/auth-interceptor';

@Injectable({ providedIn: 'root' })
export class AdminListingsClient {
  private readonly http = inject(HttpClient);
  private readonly session = inject(AuthSession);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly base = `${publicConfig.apiBaseUrl.replace(/\/$/, '')}/admin/listings`;
  private readonly options = { transferCache: false, timeout: 15000 } as const;

  list(cursor?: string, signal?: AbortSignal): Promise<AdminListingsResponse> {
    let params = new HttpParams().set('limit', 20);
    if (cursor) params = params.set('cursor', cursor);
    return this.request(
      () =>
        this.http.get<AdminListingsResponse>(`${this.base}/pending`, {
          ...this.options,
          params
        }),
      signal
    );
  }

  detail(id: string, signal?: AbortSignal): Promise<AdminListingDetail> {
    return this.request(
      () => this.http.get<AdminListingDetail>(this.path(id), this.options),
      signal
    );
  }

  decide(
    id: string,
    decision: 'approve' | 'reject',
    expectedVersion: number,
    reason: string,
    signal?: AbortSignal
  ): Promise<AdminDecisionResponse> {
    return this.request(
      () =>
        this.http.post<AdminDecisionResponse>(
          `${this.path(id)}/${decision}`,
          decision === 'reject' ? { expectedVersion, reason: reason.trim() } : { expectedVersion },
          { ...this.options, context: new HttpContext().set(skipAuthRetry, true) }
        ),
      signal
    );
  }

  variant(
    id: string,
    mediaId: string,
    variant: 'large' | 'thumbnail',
    signal?: AbortSignal
  ): Promise<Blob> {
    return this.request(
      () =>
        this.http.get(`${this.path(id)}/media/${encodeURIComponent(mediaId)}/${variant}`, {
          ...this.options,
          responseType: 'blob'
        }),
      signal
    );
  }

  private path(id: string): string {
    return `${this.base}/${encodeURIComponent(id)}`;
  }

  private authorize(signal?: AbortSignal): string {
    signal?.throwIfAborted();
    const user = this.session.user();
    if (!this.browser || user?.role !== 'ADMIN') throw new HttpErrorResponse({ status: 403 });
    return `${user.id}:${this.session.identityVersion()}`;
  }

  private async request<T>(operation: () => Observable<T>, signal?: AbortSignal): Promise<T> {
    const account = this.authorize(signal);
    const response = operation();
    const result = await firstValueFrom(
      signal ? response.pipe(takeUntil(fromEvent(signal, 'abort'))) : response
    );
    if (account !== this.authorize(signal)) throw new HttpErrorResponse({ status: 403 });
    return result;
  }
}
