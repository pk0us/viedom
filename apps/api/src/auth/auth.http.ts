import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response, CookieOptions } from 'express';
import { Configuration } from '../configuration.js';
import { AuthStore } from './auth.store.js';
import { csrfFor, equalToken, randomToken } from './auth.crypto.js';

export function cookie(request: Request, name: string): string | null {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_.-]{1,256}$/.test(value) ? value : null;
}
export function noStore(response: Response): void {
  response.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex'
  });
}
@Injectable()
export class AuthHttp {
  constructor(
    private readonly configuration: Configuration,
    private readonly store: AuthStore
  ) {}
  get config() {
    return this.configuration.values;
  }
  options(path = '/api/auth'): CookieOptions {
    return { httpOnly: true, secure: this.config.auth.secure, sameSite: 'lax', path };
  }
  get bootstrapName() {
    return `${this.config.auth.cookieName}_csrf`;
  }
  get oauthName() {
    return `${this.config.auth.cookieName}_oauth`;
  }
  origin(request: Request): void {
    if (request.headers.origin !== this.config.webOrigin) throw new ForbiddenException();
  }
  refreshCookie(request: Request): string {
    const value = cookie(request, this.config.auth.cookieName);
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new UnauthorizedException();
    return value;
  }
  writeRefresh(response: Response, token: string, expiresAt: Date): void {
    response.cookie(this.config.auth.cookieName, token, { ...this.options(), expires: expiresAt });
    response.clearCookie(this.bootstrapName, this.options());
  }
  clearRefresh(response: Response): void {
    response.clearCookie(this.config.auth.cookieName, this.options());
  }
  sessionCsrf(sessionId: string): string {
    return csrfFor(this.config.auth.accessSecret, `session:${sessionId}`);
  }

  async bootstrap(request: Request, response: Response) {
    // Custom header forces cross-origin preflight. CORS permits only WEB_ORIGIN.
    if (request.headers['x-csrf-bootstrap'] !== '1') throw new ForbiddenException();
    if (request.headers.origin) this.origin(request);
    await this.store.limit('csrf', request.ip ?? '', 120, 60);
    const token = cookie(request, this.config.auth.cookieName);
    const session = token ? await this.store.sessionFor(token) : null;
    if (session && session.currentHash)
      return { csrfToken: this.sessionCsrf(session._id.toHexString()) };
    const nonce = `${Math.floor(Date.now() / 1000)}.${randomToken()}`;
    response.cookie(this.bootstrapName, nonce, { ...this.options(), maxAge: 600_000 });
    return { csrfToken: csrfFor(this.config.auth.accessSecret, `bootstrap:${nonce}`) };
  }
  async check(request: Request, sessionRequired: boolean): Promise<void> {
    this.origin(request);
    const header = request.headers['x-csrf-token'];
    const token = cookie(request, this.config.auth.cookieName);
    const session = token ? await this.store.sessionFor(token) : null;
    if (session && equalToken(header, this.sessionCsrf(session._id.toHexString()))) return;
    if (sessionRequired && !session) throw new UnauthorizedException();
    if (!sessionRequired) {
      const nonce = cookie(request, this.bootstrapName);
      const match = /^(\d{10})\.[A-Za-z0-9_-]{43}$/.exec(nonce ?? '');
      const age = match ? Date.now() / 1000 - Number(match[1]) : Infinity;
      if (
        nonce &&
        age >= 0 &&
        age < 600 &&
        equalToken(header, csrfFor(this.config.auth.accessSecret, `bootstrap:${nonce}`))
      )
        return;
    }
    throw new ForbiddenException();
  }
}
