import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { firstValueFrom, fromEvent, takeUntil } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  MediaUploadRequest,
  MediaUploadResponse,
  OwnerMediaGallery,
  UpdateMediaGalleryRequest
} from '@viedom/contracts';
import { publicConfig } from '../../generated/public-config';
import { AuthSession } from '../core/auth/auth-session';

@Injectable({ providedIn: 'root' })
export class OwnerMediaClient {
  private readonly http = inject(HttpClient);
  private readonly session = inject(AuthSession);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly base = publicConfig.apiBaseUrl.replace(/\/$/, '');
  private readonly options = { transferCache: false, timeout: 15000 } as const;

  gallery(id: string, signal?: AbortSignal): Promise<OwnerMediaGallery> {
    return this.request(
      () => this.http.get<OwnerMediaGallery>(this.path(id), this.options),
      signal
    );
  }

  reserve(
    id: string,
    body: MediaUploadRequest,
    signal?: AbortSignal
  ): Promise<MediaUploadResponse> {
    return this.request(
      () => this.http.post<MediaUploadResponse>(`${this.path(id)}/upload-url`, body, this.options),
      signal
    );
  }

  complete(
    id: string,
    mediaId: string,
    expectedVersion: number,
    signal?: AbortSignal
  ): Promise<OwnerMediaGallery> {
    return this.request(
      () =>
        this.http.post<OwnerMediaGallery>(
          `${this.path(id)}/complete`,
          { mediaId, expectedVersion },
          this.options
        ),
      signal
    );
  }

  update(
    id: string,
    body: UpdateMediaGalleryRequest,
    signal?: AbortSignal
  ): Promise<OwnerMediaGallery> {
    return this.request(
      () => this.http.patch<OwnerMediaGallery>(this.path(id), body, this.options),
      signal
    );
  }

  remove(
    id: string,
    mediaId: string,
    expectedVersion: number,
    signal?: AbortSignal
  ): Promise<OwnerMediaGallery> {
    return this.request(
      () =>
        this.http.delete<OwnerMediaGallery>(`${this.path(id)}/${encodeURIComponent(mediaId)}`, {
          ...this.options,
          body: { expectedVersion }
        }),
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
        this.http.get(`${this.path(id)}/${encodeURIComponent(mediaId)}/${variant}`, {
          ...this.options,
          responseType: 'blob'
        }),
      signal
    );
  }

  async upload(
    reservation: MediaUploadResponse,
    file: File,
    progress: (percent: number) => void,
    signal: AbortSignal
  ): Promise<void> {
    this.authorize(signal);
    const identity = this.session.identityVersion();
    // Storage receives only the signed content declaration, never API bearer credentials.
    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      const abort = () => request.abort();
      const finish = (error?: unknown) => {
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      request.open('PUT', reservation.uploadUrl);
      request.withCredentials = false;
      request.timeout = 120000;
      request.setRequestHeader('Content-Type', reservation.headers['Content-Type']);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable && !signal.aborted)
          progress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      };
      request.onload = () =>
        request.status >= 200 && request.status < 300
          ? finish()
          : finish(new HttpErrorResponse({ status: request.status }));
      request.onerror = () => finish(new HttpErrorResponse({ status: 0 }));
      request.ontimeout = () => finish(new HttpErrorResponse({ status: 0 }));
      request.onabort = () => finish(new DOMException('Upload cancelled.', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      request.send(file);
    });
    this.authorize(signal);
    if (identity !== this.session.identityVersion()) throw new HttpErrorResponse({ status: 401 });
    progress(100);
  }

  private path(id: string): string {
    return `${this.base}/listings/${encodeURIComponent(id)}/media`;
  }

  private authorize(signal?: AbortSignal): void {
    if (!this.browser || !this.session.user()) throw new HttpErrorResponse({ status: 401 });
    signal?.throwIfAborted();
  }

  private async request<T>(operation: () => Observable<T>, signal?: AbortSignal): Promise<T> {
    this.authorize(signal);
    const identity = this.session.identityVersion();
    const observable = operation();
    const result = await firstValueFrom(
      signal ? observable.pipe(takeUntil(fromEvent(signal, 'abort'))) : observable
    );
    this.authorize(signal);
    if (identity !== this.session.identityVersion()) throw new HttpErrorResponse({ status: 401 });
    return result;
  }
}
