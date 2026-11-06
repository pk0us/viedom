import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  CreateListingRequest,
  ListingStatus,
  OwnerListingDetail,
  OwnerListingPreview,
  OwnerListingsResponse,
  OwnerProperty,
  PropertyContent,
  UpdateListingRequest,
  UpdatePropertyRequest
} from '@viedom/contracts';
import { publicConfig } from '../../generated/public-config';
import { AuthSession } from '../core/auth/auth-session';

@Injectable({ providedIn: 'root' })
export class OwnerListingsClient {
  private readonly http = inject(HttpClient);
  private readonly session = inject(AuthSession);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly base = publicConfig.apiBaseUrl.replace(/\/$/, '');
  private readonly options = { transferCache: false, timeout: 15000 } as const;

  list(status?: ListingStatus, cursor?: string): Promise<OwnerListingsResponse> {
    let params = new HttpParams().set('limit', 20);
    if (status) params = params.set('status', status);
    if (cursor) params = params.set('cursor', cursor);
    return this.request(() =>
      firstValueFrom(
        this.http.get<OwnerListingsResponse>(`${this.base}/me/listings`, {
          ...this.options,
          params
        })
      )
    );
  }

  detail(id: string): Promise<OwnerListingDetail> {
    return this.request(() =>
      firstValueFrom(
        this.http.get<OwnerListingDetail>(
          `${this.base}/me/listings/${encodeURIComponent(id)}`,
          this.options
        )
      )
    );
  }

  preview(id: string): Promise<OwnerListingPreview> {
    return this.request(() =>
      firstValueFrom(
        this.http.get<OwnerListingPreview>(
          `${this.base}/me/listings/${encodeURIComponent(id)}/preview`,
          this.options
        )
      )
    );
  }

  getProperty(id: string): Promise<OwnerProperty> {
    return this.request(() =>
      firstValueFrom(
        this.http.get<OwnerProperty>(
          `${this.base}/properties/${encodeURIComponent(id)}`,
          this.options
        )
      )
    );
  }

  createProperty(body: PropertyContent): Promise<OwnerProperty> {
    return this.request(() =>
      firstValueFrom(this.http.post<OwnerProperty>(`${this.base}/properties`, body, this.options))
    );
  }

  updateProperty(id: string, body: UpdatePropertyRequest): Promise<OwnerProperty> {
    return this.request(() =>
      firstValueFrom(
        this.http.patch<OwnerProperty>(
          `${this.base}/properties/${encodeURIComponent(id)}`,
          body,
          this.options
        )
      )
    );
  }

  createListing(body: CreateListingRequest): Promise<OwnerListingDetail> {
    return this.request(() =>
      firstValueFrom(
        this.http.post<OwnerListingDetail>(`${this.base}/listings`, body, this.options)
      )
    );
  }

  updateListing(id: string, body: UpdateListingRequest): Promise<OwnerListingDetail> {
    return this.request(() =>
      firstValueFrom(
        this.http.patch<OwnerListingDetail>(
          `${this.base}/listings/${encodeURIComponent(id)}`,
          body,
          this.options
        )
      )
    );
  }

  action(
    id: string,
    action: 'pause' | 'archive' | 'submit' | 'resume',
    expectedVersion: number
  ): Promise<OwnerListingDetail> {
    return this.request(() =>
      firstValueFrom(
        this.http.post<OwnerListingDetail>(
          `${this.base}/listings/${encodeURIComponent(id)}/${action}`,
          { expectedVersion },
          this.options
        )
      )
    );
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.browser || !this.session.user()) throw new HttpErrorResponse({ status: 401 });
    const identity = this.session.identityVersion();
    const result = await operation();
    if (identity !== this.session.identityVersion()) throw new HttpErrorResponse({ status: 401 });
    return result;
  }
}
