import type { Request, Response } from 'express';
import { loadConfig } from '../../../../scripts/config.mjs';
import { Configuration } from '../configuration.js';
import { AuthHttp, cookie } from './auth.http.js';
import { AuthStore } from './auth.store.js';

it('rejects ambiguous cookies and mismatched origins', () => {
  const request = (value: string) => ({ headers: { cookie: value } }) as Request;
  expect(cookie(request('session=abc; other=value'), 'session')).toBe('abc');
  expect(cookie(request('session=abc; session=def'), 'session')).toBeNull();
  expect(cookie(request('session=encoded%3Bvalue'), 'session')).toBeNull();
  const http = new AuthHttp({ values: loadConfig() } as Configuration, {} as AuthStore);
  expect(() => http.origin({ headers: {} } as Request)).toThrow();
  expect(() => http.origin({ headers: { origin: 'https://evil.invalid' } } as Request)).toThrow();
});

it('sets Secure production cookies and clears them with the same scope', () => {
  const config = loadConfig();
  const http = new AuthHttp(
    { values: { ...config, auth: { ...config.auth, secure: true } } } as Configuration,
    {} as AuthStore
  );
  const response = { cookie: vi.fn(), clearCookie: vi.fn() };
  const expires = new Date();
  http.writeRefresh(response as unknown as Response, 'synthetic', expires);
  http.clearRefresh(response as unknown as Response);
  expect(response.cookie).toHaveBeenCalledWith(config.auth.cookieName, 'synthetic', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth',
    expires
  });
  expect(response.clearCookie).toHaveBeenCalledWith(config.auth.cookieName, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth'
  });
});
