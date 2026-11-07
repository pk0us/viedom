import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  ListingMarkersQuery,
  ListingMarkersResponse,
  ListingSearchQuery,
  ListingSearchResponse
} from '@viedom/contracts';
import { publicConfig } from '../../../generated/public-config';
import { queryParams } from './search-model';

@Injectable({ providedIn: 'root' })
export class SearchClient {
  private readonly http = inject(HttpClient);
  private readonly base = publicConfig.apiBaseUrl.replace(/\/$/, '');

  cards(query: ListingSearchQuery) {
    return this.http.get<ListingSearchResponse>(`${this.base}/listings/search`, {
      params: new HttpParams({
        fromObject: {
          ...queryParams(query),
          limit: '20',
          ...(query.cursor ? { cursor: query.cursor } : {})
        }
      }),
      transferCache: false,
      timeout: 10000,
      credentials: 'omit'
    });
  }

  markers(query: ListingMarkersQuery) {
    return this.http.get<ListingMarkersResponse>(`${this.base}/listings/markers`, {
      params: new HttpParams({ fromObject: queryParams(query) }),
      transferCache: false,
      timeout: 10000,
      credentials: 'omit'
    });
  }
}
