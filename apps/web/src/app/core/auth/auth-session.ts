import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { HttpBackend, HttpClient, HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type {
  AuthResponse,
  CsrfResponse,
  CurrentUser,
  GoogleStartResponse,
  LoginRequest,
  RegisterRequest
} from '@viedom/contracts';
import { publicConfig } from '../../../generated/public-config';

export class SessionCoordinationError extends Error {}

@Injectable({ providedIn: 'root' })
export class AuthSession {
  private readonly http = new HttpClient(inject(HttpBackend));
  private readonly api = inject(HttpClient);
  private readonly window = inject(DOCUMENT).defaultView;
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly router = inject(Router);
  private readonly currentUser = signal<CurrentUser | null>(null);
  readonly user = this.currentUser.asReadonly();
  private accessToken = '';
  private expiresAt = 0;
  private refreshWork: Promise<boolean> | undefined;
  private channel?: BroadcastChannel;
  private generation = 0;

  constructor() {
    if (this.browser && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('viedom-session');
      this.channel.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (data !== 'changed' && data !== 'signed-out') return;
        this.clear();
        if (this.router.url.startsWith('/owner')) {
          void this.router.navigate(['/auth/login'], {
            queryParams: { returnUrl: this.router.url }
          });
        }
      };
      inject(DestroyRef).onDestroy(() => this.channel?.close());
    }
  }

  private clear(): void {
    this.generation++;
    this.accessToken = '';
    this.expiresAt = 0;
    this.currentUser.set(null);
  }

  identityVersion(): number {
    return this.generation;
  }

  invalidate(rejected?: string): void {
    if (rejected !== undefined && rejected !== this.accessToken) return;
    this.clear();
    if (this.router.url.startsWith('/owner')) {
      void this.router.navigate(['/auth/login'], { queryParams: { returnUrl: this.router.url } });
    }
  }

  private apply(response: AuthResponse): void {
    this.accessToken = response.accessToken;
    this.expiresAt = Date.now() + response.expiresIn * 1000;
    this.currentUser.set(response.user);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const locks = this.browser ? this.window?.navigator.locks : undefined;
    if (!locks)
      throw new SessionCoordinationError(
        'Your browser must support secure session coordination. Use a current browser over HTTPS or localhost.'
      );
    return locks.request('viedom-auth-cookie', operation);
  }

  private async csrf(): Promise<string> {
    const result = await firstValueFrom(
      this.http.get<CsrfResponse>(`${publicConfig.apiBaseUrl}/auth/csrf`, {
        withCredentials: true,
        transferCache: false,
        timeout: 10000,
        headers: { 'X-CSRF-Bootstrap': '1' }
      })
    );
    return result.csrfToken;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    // Read CSRF under the same lock as the mutation: another tab may have replaced the cookie.
    const csrfToken = await this.csrf();
    return firstValueFrom(
      this.http.post<T>(`${publicConfig.apiBaseUrl}/auth/${path}`, body, {
        withCredentials: true,
        transferCache: false,
        timeout: 15000,
        headers: { 'X-CSRF-Token': csrfToken }
      })
    );
  }

  restore(): Promise<boolean> {
    if (!this.browser) return Promise.resolve(false);
    if (this.accessToken && this.expiresAt > Date.now() + 30000) return Promise.resolve(true);
    if (this.refreshWork) return this.refreshWork;
    const generation = this.generation;
    this.refreshWork = this.exclusive(async () => {
      if (generation !== this.generation) return false;
      try {
        const response = await this.post<AuthResponse>('refresh', {});
        if (generation !== this.generation) return false;
        this.apply(response);
        return true;
      } catch (error) {
        this.invalidate();
        if (error instanceof HttpErrorResponse && error.status === 401) return false;
        throw error;
      }
    }).finally(() => {
      this.refreshWork = undefined;
    });
    return this.refreshWork;
  }

  async token(): Promise<string> {
    return (await this.restore()) ? this.accessToken : '';
  }
  async renew(rejected: string, generation = this.generation): Promise<string> {
    if (generation !== this.generation) return '';
    if (this.accessToken === rejected) this.expiresAt = 0;
    return this.token();
  }
  async login(body: LoginRequest): Promise<void> {
    await this.credentials('login', body);
  }
  async register(body: RegisterRequest): Promise<void> {
    await this.credentials('register', body);
  }
  private async credentials(path: string, body: LoginRequest | RegisterRequest): Promise<void> {
    await this.exclusive(async () => {
      const response = await this.post<AuthResponse>(path, body);
      this.clear();
      this.apply(response);
      this.channel?.postMessage('changed');
    });
  }
  async logout(): Promise<void> {
    await this.exclusive(async () => {
      try {
        await this.post<void>('logout', {});
      } catch (error) {
        if (!(error instanceof HttpErrorResponse && error.status === 401)) throw error;
      }
      this.clear();
      this.channel?.postMessage('signed-out');
    });
    await this.router.navigateByUrl('/auth/login');
  }
  async requestVerification(email: string): Promise<void> {
    await this.exclusive(() => this.post('verification/request', { email }));
  }
  async forgotPassword(email: string): Promise<void> {
    await this.exclusive(() => this.post('forgot-password', { email }));
  }
  async confirmEmail(token: string): Promise<void> {
    await this.exclusive(() => this.post('verification/confirm', { token }));
    if (this.user()) {
      try {
        await this.reloadUser();
      } catch {
        this.clear();
      }
    }
  }
  async resetPassword(token: string, password: string): Promise<void> {
    await this.exclusive(async () => {
      await this.post('reset-password', { token, password });
      this.clear();
      this.channel?.postMessage('signed-out');
      try {
        await this.csrf();
      } catch {
        /* Reset succeeded; the next login will bootstrap CSRF again. */
      }
    });
  }
  async reloadUser(): Promise<void> {
    const token = await this.token();
    if (!token) return;
    const generation = this.generation;
    const user = await firstValueFrom(
      this.api.get<CurrentUser>(`${publicConfig.apiBaseUrl}/me`, {
        transferCache: false,
        timeout: 10000
      })
    );
    if (generation === this.generation) this.currentUser.set(user);
  }
  async googleStart(): Promise<string> {
    return this.exclusive(async () => {
      const result = await this.post<GoogleStartResponse>('google/start', {});
      const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth')
        throw new Error('Invalid authorization destination.');
      return url.href;
    });
  }
}
