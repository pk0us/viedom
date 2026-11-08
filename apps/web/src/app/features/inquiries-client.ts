import { isPlatformBrowser } from '@angular/common';
import { HttpBackend, HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  CreateInquiryRequest,
  InquiryReceipt,
  OwnerInquiriesResponse,
  OwnerInquiry,
  UpdateInquiryRequest
} from '@viedom/contracts';
import { publicConfig } from '../../generated/public-config';
import { AuthSession } from '../core/auth/auth-session';

@Injectable({ providedIn: 'root' })
export class InquiriesClient {
  private readonly http = inject(HttpClient);
  private readonly publicHttp = new HttpClient(inject(HttpBackend));
  private readonly session = inject(AuthSession);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly base = publicConfig.apiBaseUrl.replace(/\/$/, '');
  private readonly options = { transferCache: false, timeout: 15000 } as const;

  async create(listingId: string, body: CreateInquiryRequest): Promise<InquiryReceipt> {
    if (!this.browser) throw new HttpErrorResponse({ status: 400 });
    const identity = this.session.identityVersion();
    const authenticated = !!this.session.user();
    const token = authenticated ? await this.session.token() : '';
    if (authenticated && (!token || identity !== this.session.identityVersion()))
      throw new HttpErrorResponse({ status: 401 });
    return firstValueFrom(
      this.publicHttp.post<InquiryReceipt>(
        `${this.base}/listings/${encodeURIComponent(listingId)}/inquiries`,
        body,
        {
          ...this.options,
          headers: {
            'X-Inquiry-Request': '1',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          }
        }
      )
    );
  }

  list(cursor?: string): Promise<OwnerInquiriesResponse> {
    let params = new HttpParams().set('limit', 20);
    if (cursor) params = params.set('cursor', cursor);
    return this.privateRequest(() =>
      firstValueFrom(
        this.http.get<OwnerInquiriesResponse>(`${this.base}/me/inquiries`, {
          ...this.options,
          params
        })
      )
    );
  }

  update(id: string, body: UpdateInquiryRequest): Promise<OwnerInquiry> {
    return this.privateRequest(() =>
      firstValueFrom(
        this.http.patch<OwnerInquiry>(
          `${this.base}/me/inquiries/${encodeURIComponent(id)}`,
          body,
          this.options
        )
      )
    );
  }

  private async privateRequest<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.browser || !this.session.user()) throw new HttpErrorResponse({ status: 401 });
    const identity = this.session.identityVersion();
    const result = await operation();
    if (identity !== this.session.identityVersion()) throw new HttpErrorResponse({ status: 401 });
    return result;
  }
}
