import { Controller, Get, UseGuards, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { JwtService } from '@nestjs/jwt';
import type { Profile } from 'passport-google-oauth20';
import { loadConfig } from '../../../scripts/config.mjs';
import { localTarget } from '../src/database/local-target.js';
import { ormOptions } from '../src/database/orm-options.js';
import { provision } from '../src/database/provision.js';
import { Configuration } from '../src/configuration.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthStore } from '../src/auth/auth.store.js';
import { GoogleStrategy } from '../src/auth/google.auth.js';
import { JwtAuthGuard, Roles, RolesGuard, VerifiedEmailGuard } from '../src/auth/auth.guards.js';
import { ApiErrorFilter } from '../src/api-error.filter.js';
import { digest } from '../src/auth/auth.crypto.js';
import type { AuthResponse } from '@viedom/contracts';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

@Controller('probe')
class ProbeController {
  @Get('admin') @UseGuards(JwtAuthGuard, RolesGuard) @Roles('ADMIN') admin() {
    return { allowed: true };
  }
  @Get('verified') @UseGuards(JwtAuthGuard, VerifiedEmailGuard) verified() {
    return { allowed: true };
  }
}

const config = loadConfig();
const run = new ObjectId().toHexString();
const password = 'A long synthetic password';
const users = new Set<string>();
const rateIds = new Set<string>();
const stateIds = new Set<string>();
let orm: MikroORM;
let store: AuthStore;
let app: INestApplication;
let base: string;
let accountCounter = 0;
const provider = { subject: `${run}google`, email: `${run}.google@example.invalid` };
let profile: Profile;
const exchange = vi.fn();

class Client {
  jar = new Map<string, string>();
  csrf = '';
  token = '';
  async request(
    path: string,
    options: {
      body?: unknown;
      method?: string;
      origin?: string;
      csrf?: string;
      bearer?: string;
      bootstrap?: boolean;
    } = {}
  ) {
    const response = await fetch(`${base}/api/${path}`, {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      redirect: 'manual',
      headers: {
        Origin: options.origin ?? config.webOrigin,
        'Content-Type': 'application/json',
        Cookie: [...this.jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(options.bootstrap ? { 'X-CSRF-Bootstrap': '1' } : {}),
        'X-CSRF-Token': options.csrf ?? this.csrf,
        ...((options.bearer ?? this.token)
          ? { Authorization: `Bearer ${options.bearer ?? this.token}` }
          : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const equals = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, equals), pair!.slice(equals + 1));
    }
    return response;
  }
  async bootstrap() {
    const response = await this.request('auth/csrf', { bootstrap: true });
    expect(response.status).toBe(200);
    this.csrf = (await response.json()).csrfToken;
  }
  use(result: AuthResponse) {
    this.csrf = result.csrfToken;
    this.token = result.accessToken;
  }
}

async function register(client = new Client()) {
  await client.bootstrap();
  const email = `${run}.${accountCounter++}@example.invalid`;
  const response = await client.request('auth/register', {
    body: { email, password, firstName: 'Synthetic', lastName: 'Test' }
  });
  expect(response.status).toBe(201);
  const result: AuthResponse = await response.json();
  users.add(result.user.id);
  client.use(result);
  return { client, result, response, email };
}

beforeAll(async () => {
  const target = localTarget(config, true);
  orm = await MikroORM.init(ormOptions(target.uri, target.dbName));
  await provision(orm);
  const testing = await Test.createTestingModule({
    imports: [AuthModule],
    controllers: [ProbeController]
  })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .overrideProvider(Configuration)
    .useValue({
      values: {
        ...config,
        auth: {
          ...config.auth,
          googleClientId: 'synthetic.apps.googleusercontent.com',
          googleClientSecret: 'synthetic-client-secret'
        }
      }
    })
    .compile();
  app = testing.createNestApplication();
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );
  app.useGlobalFilters(new ApiErrorFilter());
  store = app.get(AuthStore);
  const limit = store.limit.bind(store);
  vi.spyOn(store, 'limit').mockImplementation(async (scope, key, maximum, seconds) => {
    const ownedKey = `${run}:${key}`;
    rateIds.add(digest(`${scope}:${ownedKey}:${Math.floor(Date.now() / (seconds * 1000))}`));
    return limit(scope, ownedKey, maximum, seconds);
  });
  profile = {
    provider: 'google',
    id: provider.subject,
    displayName: 'Synthetic Google',
    name: { givenName: 'Synthetic', familyName: 'Google' },
    emails: [{ value: provider.email, verified: true }],
    _raw: '',
    _json: {}
  } as Profile;
  const strategy = app.get(GoogleStrategy);
  vi.spyOn(strategy, 'userProfile').mockImplementation((_token, done) => done(null, profile));
  // Exercise Passport's real callback/state path; only external Google transport is replaced.
  const transport = strategy as unknown as { _oauth2: { getOAuthAccessToken: typeof exchange } };
  exchange.mockImplementation((_code, params, done) => {
    expect(params.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    done(null, 'SYNTHETIC_GOOGLE_ACCESS', 'SYNTHETIC_GOOGLE_REFRESH', {});
  });
  vi.spyOn(transport._oauth2, 'getOAuthAccessToken').mockImplementation(exchange);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  if (orm && store) {
    // Only this run's exact IDs are removed; never reset a collection/database.
    for (const user of await store.users.find({ email: { $regex: `^${run}\\.` } }).toArray())
      users.add(user._id.toHexString());
    const userIds = [...users].map((id) => new ObjectId(id));
    const sessions = await store.sessions.find({ userId: { $in: userIds } }).toArray();
    await store.tokens.deleteMany({ sessionId: { $in: sessions.map((session) => session._id) } });
    await store.sessions.deleteMany({ _id: { $in: sessions.map((session) => session._id) } });
    await store.identities.deleteMany({ userId: { $in: userIds } });
    await store.users.deleteMany({ _id: { $in: userIds } });
    await store.rates.deleteMany({ _id: { $in: [...rateIds] } });
    await store.states.deleteMany({ _id: { $in: [...stateIds] } });
  }
  if (app) await app.close();
  if (orm) await orm.close(true);
});

it('registers only USER, rejects duplicates, returns a safe projection and localhost cookie', async () => {
  const { client, result, response, email } = await register();
  expect(result.user).toEqual({
    id: expect.any(String),
    email,
    firstName: 'Synthetic',
    lastName: 'Test',
    role: 'USER',
    emailVerified: false
  });
  const cookies = response.headers.getSetCookie().join(';');
  expect(cookies).toContain('HttpOnly');
  expect(cookies).toContain('SameSite=Lax');
  expect(cookies).toContain('Path=/api/auth');
  expect(cookies).not.toContain('Secure');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await client.request('me')).status).toBe(200);
  expect(
    (
      await client.request('auth/register', {
        body: { email, password, firstName: 'Test', lastName: 'Test' }
      })
    ).status
  ).toBe(409);
  expect(
    (
      await client.request('auth/register', {
        body: { email, password, firstName: 'Test', lastName: 'Test', role: 'ADMIN' }
      })
    ).status
  ).toBe(400);
  const user = await store.credentials(email);
  expect(user!.passwordHash).toMatch(/^scrypt\$/);
  expect(JSON.stringify(result)).not.toContain(user!.passwordHash!);
});

it('rejects invalid credentials, missing bearer, expired/wrong-audience/wrong-algorithm JWTs and role/verification denial', async () => {
  const { client, result, email } = await register();
  const badLogin = await client.request('auth/login', { body: { email, password: 'wrong' } });
  expect(badLogin.status).toBe(401);
  expect(await badLogin.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  expect((await new Client().request('me')).status).toBe(401);
  expect((await client.request('probe/admin')).status).toBe(403);
  expect((await client.request('probe/verified')).status).toBe(403);
  const jwt = app.get(JwtService);
  for (const options of [
    { expiresIn: -1 },
    { audience: 'other' },
    { algorithm: 'HS512' as const }
  ]) {
    const token = await jwt.signAsync(
      { sub: result.user.id, sid: new ObjectId().toHexString() },
      {
        secret: config.auth.accessSecret,
        issuer: 'viedom-api',
        audience: 'viedom-web',
        expiresIn: 600,
        ...options
      }
    );
    expect((await client.request('me', { bearer: token })).status).toBe(401);
  }
  const login = await client.request('auth/login', {
    body: { email: email.toUpperCase(), password }
  });
  expect(login.status).toBe(200);
});

it('rotates tokens, preserves absolute expiry, detects replay and invalidates the family including access JWTs', async () => {
  const { client, result } = await register();
  const oldToken = client.jar.get(config.auth.cookieName)!;
  const family = await store.sessionFor(oldToken);
  const refreshed = await client.request('auth/refresh', { body: {} });
  expect(refreshed.status).toBe(200);
  const next: AuthResponse = await refreshed.json();
  client.use(next);
  const newToken = client.jar.get(config.auth.cookieName)!;
  expect(newToken).not.toBe(oldToken);
  expect((await store.sessionFor(newToken))!.expiresAt).toEqual(family!.expiresAt);
  const database = JSON.stringify(await store.tokens.find({ sessionId: family!._id }).toArray());
  expect(database).not.toContain(oldToken);
  expect(database).not.toContain(newToken);
  const attacker = new Client();
  attacker.jar.set(config.auth.cookieName, oldToken);
  attacker.csrf = result.csrfToken;
  expect((await attacker.request('auth/refresh', { body: {} })).status).toBe(401);
  expect((await client.request('me')).status).toBe(401);
  expect((await client.request('auth/refresh', { body: {} })).status).toBe(401);
});

it('handles concurrent refresh conservatively with one response and family revocation', async () => {
  const { client, result } = await register();
  const other = new Client();
  other.jar = new Map(client.jar);
  other.csrf = result.csrfToken;
  const responses = await Promise.all([
    client.request('auth/refresh', { body: {} }),
    other.request('auth/refresh', { body: {} })
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  expect((await client.request('me')).status).toBe(401);
});

it('enforces origin and session-bound CSRF, logs out and immediately rejects existing access', async () => {
  const { client } = await register();
  expect(
    (await client.request('auth/refresh', { body: {}, origin: 'https://untrusted.invalid' })).status
  ).toBe(403);
  expect((await client.request('auth/refresh', { body: {}, csrf: 'wrong' })).status).toBe(403);
  expect((await client.request('me')).status).toBe(200);
  const logout = await client.request('auth/logout', { body: {} });
  expect(logout.status).toBe(204);
  expect(await logout.text()).toBe('');
  expect(logout.headers.getSetCookie().join(';')).toContain('Path=/api/auth');
  expect((await client.request('me')).status).toBe(401);
});

it('rejects suspended/deleted/passwordless accounts and checks current roles and verification', async () => {
  const { client, result, email } = await register();
  const _id = new ObjectId(result.user.id);
  await store.users.updateOne({ _id }, { $set: { role: 'ADMIN', emailVerifiedAt: new Date() } });
  expect((await client.request('probe/admin')).status).toBe(200);
  expect((await client.request('probe/verified')).status).toBe(200);
  for (const status of ['suspended', 'deleted'] as const) {
    await store.users.updateOne({ _id }, { $set: { status } });
    expect((await client.request('me')).status).toBe(401);
    expect((await client.request('auth/login', { body: { email, password } })).status).toBe(401);
  }
  await store.users.updateOne({ _id }, { $set: { status: 'active', passwordHash: null } });
  expect((await client.request('auth/login', { body: { email, password } })).status).toBe(401);
});

it('rejects refresh expiry independently of asynchronous TTL cleanup', async () => {
  const { client } = await register();
  const token = client.jar.get(config.auth.cookieName)!;
  const session = await store.sessionFor(token);
  await store.sessions.updateOne({ _id: session!._id }, { $set: { expiresAt: new Date(0) } });
  expect((await client.request('auth/refresh', { body: {} })).status).toBe(401);
  expect((await client.request('me')).status).toBe(401);
});

async function startGoogle(client: Client) {
  await client.bootstrap();
  const response = await client.request('auth/google/start', { body: {} });
  expect(response.status).toBe(200);
  const url = new URL((await response.json()).authorizationUrl);
  const state = url.searchParams.get('state')!;
  stateIds.add(digest(state));
  expect(url.origin).toBe('https://accounts.google.com');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  return state;
}

it('uses Passport Google state/PKCE, creates USER once and hands off without URL credentials', async () => {
  const client = new Client();
  const state = await startGoogle(client);
  const stolen = new Client();
  expect((await stolen.request(`auth/google/callback?code=synthetic&state=${state}`)).status).toBe(
    401
  );
  const callback = await client.request(`auth/google/callback?code=synthetic&state=${state}`);
  expect(callback.status).toBe(303);
  expect(callback.headers.get('location')).toBe(`${config.webOrigin}/auth/callback`);
  expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
  const account = await store.credentials(provider.email);
  users.add(account!._id.toHexString());
  expect(account!.role).toBe('USER');
  expect(account!.passwordHash).toBeNull();
  expect(account!.emailVerifiedAt).toBeInstanceOf(Date);
  expect((await client.request(`auth/google/callback?code=synthetic&state=${state}`)).status).toBe(
    401
  );
  await client.bootstrap();
  const response = await client.request('auth/refresh', { body: {} });
  expect(response.status).toBe(200);
  client.use(await response.json());
  expect((await client.request('me')).status).toBe(200);
  const next = await startGoogle(client);
  expect((await client.request(`auth/google/callback?code=synthetic&state=${next}`)).status).toBe(
    303
  );
  expect(
    await store.identities.countDocuments({ provider: 'google', subject: provider.subject })
  ).toBe(1);
});

it('rejects expired/cancelled OAuth state, unverified Google email and matching-email account takeover', async () => {
  const client = new Client();
  const state = await startGoogle(client);
  await store.states.updateOne({ _id: digest(state) }, { $set: { expiresAt: new Date(0) } });
  expect((await client.request(`auth/google/callback?code=synthetic&state=${state}`)).status).toBe(
    401
  );
  const cancelled = await startGoogle(client);
  expect(
    (await client.request(`auth/google/callback?error=access_denied&state=${cancelled}`)).status
  ).toBe(401);
  expect(await store.states.findOne({ _id: digest(cancelled) })).toBeNull();
  const original = profile;
  try {
    profile = { ...original, emails: [{ value: provider.email, verified: false }] };
    const unverified = await startGoogle(client);
    expect(
      (await client.request(`auth/google/callback?code=synthetic&state=${unverified}`)).status
    ).toBe(401);
    const { email } = await register();
    profile = { ...original, id: `${run}collision`, emails: [{ value: email, verified: true }] };
    const collision = await startGoogle(client);
    expect(
      (await client.request(`auth/google/callback?code=synthetic&state=${collision}`)).status
    ).toBe(409);
    expect(await store.identities.findOne({ subject: profile.id })).toBeNull();
  } finally {
    profile = original;
  }
});

it('enforces persistent abuse counters with safe errors and Retry-After', async () => {
  const client = new Client();
  await client.bootstrap();
  for (let attempt = 0; attempt < 10; attempt++) await store.limit('limit-probe', 'owned', 10, 900);
  await expect(store.limit('limit-probe', 'owned', 10, 900)).rejects.toMatchObject({ status: 429 });
  // Hit the credential counter without doing password hashing.
  const email = `${run}.limited@example.invalid`;
  for (let attempt = 0; attempt < 10; attempt++)
    await store.limit('credentials-email', email, 10, 900);
  const response = await client.request('auth/login', { body: { email, password } });
  expect(response.status).toBe(429);
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(900);
  expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
});

it.runIf(process.env['AUTH_BROWSER_SMOKE'] === '1')(
  'verifies credentialed localhost CORS, HttpOnly cookie scope, refresh and logout in Chrome',
  async () => {
    const web = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Authentication API test</title>');
    });
    await new Promise<void>((resolve, reject) => {
      web.once('error', reject);
      web.listen(config.ports.web, 'localhost', resolve);
    });
    let browser;
    try {
      browser = await chromium.launch({
        ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
        headless: true
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(config.webOrigin);
      const result = await page.evaluate(
        async ({ api, email, password }) => {
          const request = async (path: string, body?: unknown, csrf?: string, bearer?: string) =>
            fetch(`${api}/${path}`, {
              method: body === undefined ? 'GET' : 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Bootstrap': '1',
                ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
                ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
          const csrf = await (await request('auth/csrf')).json();
          const registered = await request(
            'auth/register',
            { email, password, firstName: 'Browser', lastName: 'Test' },
            csrf.csrfToken
          );
          const session: AuthResponse = await registered.json();
          const refreshed = await request('auth/refresh', {}, session.csrfToken);
          const next: AuthResponse = await refreshed.json();
          // Access JWT stays in this evaluation's memory only.
          const me = await request('me', undefined, undefined, next.accessToken);
          return {
            id: session.user.id,
            register: registered.status,
            refresh: refreshed.status,
            me: me.status,
            csrf: next.csrfToken,
            access: next.accessToken,
            visibleCookies: document.cookie
          };
        },
        {
          api: base.replace('127.0.0.1', 'localhost') + '/api',
          email: `${run}.browser@example.invalid`,
          password
        }
      );
      if (result.id) users.add(result.id);
      expect([result.register, result.refresh, result.me]).toEqual([201, 200, 200]);
      expect(result.visibleCookies).not.toContain(config.auth.cookieName);
      const refreshCookie = (await context.cookies()).find(
        (entry) => entry.name === config.auth.cookieName
      )!;
      expect(refreshCookie).toMatchObject({
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
        path: '/api/auth',
        domain: 'localhost'
      });
      const logout = await page.evaluate(
        async ({ api, csrf, access }) => {
          const response = await fetch(`${api}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: '{}'
          });
          const me = await fetch(`${api}/me`, { headers: { Authorization: `Bearer ${access}` } });
          return [response.status, me.status];
        },
        {
          api: base.replace('127.0.0.1', 'localhost') + '/api',
          csrf: result.csrf,
          access: result.access
        }
      );
      expect(logout).toEqual([204, 401]);
      expect((await context.cookies()).some((entry) => entry.name === config.auth.cookieName)).toBe(
        false
      );
      await context.close();
    } finally {
      await browser?.close();
      await new Promise<void>((resolve, reject) =>
        web.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
);
