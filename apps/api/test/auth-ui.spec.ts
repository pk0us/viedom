import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/mongodb';
import { chromium, expect as browserExpect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Profile } from 'passport-google-oauth20';
import { loadConfig, root } from '../../../scripts/config.mjs';
import { localTarget } from '../src/database/local-target.js';
import { ormOptions } from '../src/database/orm-options.js';
import { provision } from '../src/database/provision.js';
import { Configuration } from '../src/configuration.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthStore } from '../src/auth/auth.store.js';
import { GoogleStrategy } from '../src/auth/google.auth.js';
import { ApiErrorFilter } from '../src/api-error.filter.js';
import { digest } from '../src/auth/auth.crypto.js';

const config = loadConfig();
const run = randomUUID();
const email = `${run}@example.invalid`;
const googleEmail = `${run}.google@example.invalid`;
const password = 'A long browser test password';
const replacement = 'A new browser test password';
const inbox = `http://127.0.0.1:${config.ports.mailUi}`;
const artifactDirectory = resolve(root, 'test-results/phase07');
const rateIds = new Set<string>();
const messageIds = new Set<string>();
let orm: MikroORM;
let store: AuthStore;
let app: INestApplication;
let web: ChildProcess;
let browser: Browser;

async function waitFor(url: string) {
  await vi.waitFor(
    async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      expect(response.ok).toBe(true);
    },
    { timeout: 20000, interval: 200 }
  );
}
beforeAll(async () => {
  const existingWeb = await fetch(config.webOrigin, { signal: AbortSignal.timeout(1000) }).catch(
    () => null
  );
  if (existingWeb)
    throw new Error('Stop the application on the configured web port before the auth smoke.');
  const target = localTarget(config, true);
  orm = await MikroORM.init(ormOptions(target.uri, target.dbName));
  await provision(orm);
  const module = await Test.createTestingModule({ imports: [AuthModule] })
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
  app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );
  app.useGlobalFilters(new ApiErrorFilter());
  store = app.get(AuthStore);
  const limit = store.limit.bind(store);
  vi.spyOn(store, 'limit').mockImplementation(async (scope, key, maximum, seconds) => {
    const owned = `${run}:${expect.getState().currentTestName ?? 'setup'}:${key}`;
    rateIds.add(digest(`${scope}:${owned}:${Math.floor(Date.now() / (seconds * 1000))}`));
    return limit(scope, owned, maximum, seconds);
  });
  const strategy = app.get(GoogleStrategy);
  vi.spyOn(strategy, 'userProfile').mockImplementation((_token, done) =>
    done(null, {
      provider: 'google',
      id: run,
      displayName: 'Browser Google',
      name: { givenName: 'Browser', familyName: 'Google' },
      emails: [{ value: googleEmail, verified: true }],
      _raw: '',
      _json: {}
    } as Profile)
  );
  const transport = strategy as unknown as {
    _oauth2: { getOAuthAccessToken: (...args: unknown[]) => void };
  };
  vi.spyOn(transport._oauth2, 'getOAuthAccessToken').mockImplementation((_code, params, done) => {
    expect((params as { code_verifier: string }).code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    (done as (error: null, access: string, refresh: string, details: object) => void)(
      null,
      'SYNTHETIC_GOOGLE_ACCESS',
      'SYNTHETIC_GOOGLE_REFRESH',
      {}
    );
  });
  await app.listen(config.ports.api, '127.0.0.1');
  web = spawn(process.execPath, ['dist/web/server/server.mjs'], {
    cwd: resolve(root, 'apps/web'),
    stdio: 'ignore',
    env: { ...process.env, PORT: String(config.ports.web) }
  });
  await waitFor(config.webOrigin);
  await mkdir(artifactDirectory, { recursive: true });
  const channel =
    process.env.SMOKE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined);
  browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });
});

afterAll(async () => {
  await browser?.close();
  if (web && web.exitCode === null && web.signalCode === null) {
    const exited = once(web, 'exit');
    web.kill();
    await exited;
  }
  if (store) {
    const users = await store.users.find({ email: { $in: [email, googleEmail] } }).toArray();
    const ids = users.map((user) => user._id);
    const sessions = await store.sessions.find({ userId: { $in: ids } }).toArray();
    await store.actions.deleteMany({ userId: { $in: ids } });
    await store.deliveries.deleteMany({ userId: { $in: ids } });
    await store.tokens.deleteMany({ sessionId: { $in: sessions.map((session) => session._id) } });
    await store.sessions.deleteMany({ userId: { $in: ids } });
    await store.identities.deleteMany({ userId: { $in: ids } });
    await store.users.deleteMany({ _id: { $in: ids } });
    await store.rates.deleteMany({ _id: { $in: [...rateIds] } });
    const search = await fetch(`${inbox}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (search.ok) for (const message of (await search.json()).messages) messageIds.add(message.ID);
  }
  if (messageIds.size) {
    const cleanup = await fetch(`${inbox}/api/v1/messages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IDs: [...messageIds] })
    });
    expect(cleanup.ok).toBe(true);
  }
  await app?.close();
  await orm?.close(true);
});

async function capturedLink(purpose: string): Promise<string> {
  let link = '';
  await vi.waitFor(
    async () => {
      const search = await fetch(
        `${inbox}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`
      );
      expect(search.ok).toBe(true);
      for (const item of (await search.json()).messages as { ID: string }[]) {
        messageIds.add(item.ID);
        const message = (await (await fetch(`${inbox}/api/v1/message/${item.ID}`)).json()) as {
          Text: string;
        };
        if (message.Text.includes(`/auth/${purpose}#token=`))
          link = message.Text.match(/http[^\s]+/)![0]!;
      }
      expect(link).not.toBe('');
    },
    { timeout: 12000, interval: 200 }
  );
  return link;
}
async function signIn(page: Page, value = password) {
  await page.goto(`${config.webOrigin}/auth/login`);
  await page.getByLabel('Email (required)', { exact: true }).fill(email);
  await page.getByLabel('Password (required)', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await browserExpect(page).toHaveURL(`${config.webOrigin}/owner`);
}
async function noStoredCredentials(context: BrowserContext) {
  const state = await context.storageState();
  expect(state.origins.every((origin) => origin.localStorage.length === 0)).toBe(true);
  for (const page of context.pages())
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  for (const cookie of state.cookies)
    if (cookie.name.startsWith(config.auth.cookieName)) expect(cookie.httpOnly).toBe(true);
}

it('registers, verifies, coordinates tabs, restores, recovers and logs out through Chrome', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto(`${config.webOrigin}/owner`);
  await browserExpect(page).toHaveURL(/\/auth\/login\?returnUrl=/);
  await browserExpect(page.getByRole('navigation', { name: 'Owner navigation' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Create an account', exact: true }).click();
  await browserExpect(page.getByRole('heading', { level: 1 })).toHaveText('Create an account');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await browserExpect(page.getByLabel('First name (required)', { exact: true })).toBeFocused();
  await page.getByLabel('First name (required)', { exact: true }).fill('Browser');
  await page.getByLabel('Last name (required)', { exact: true }).fill('Owner');
  await page.getByLabel('Email (required)', { exact: true }).fill(email);
  await page.getByLabel('Password (required)', { exact: true }).fill(password);
  await page.getByLabel('Confirm password (required)', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await browserExpect(
    page.getByText('Your account is ready. Verify your email before submitting a listing.')
  ).toBeVisible();
  const verification = await capturedLink('verify-email');
  await page.getByRole('link', { name: 'Go to your workspace' }).click();
  await browserExpect(page.getByText('Welcome, Browser.')).toBeVisible();
  await page.reload();
  await browserExpect(page.getByText('Welcome, Browser.')).toBeVisible();
  const peer = await context.newPage();
  await Promise.all([page.reload(), peer.goto(`${config.webOrigin}/owner`)]);
  await browserExpect(page.getByText('Welcome, Browser.')).toBeVisible();
  await browserExpect(peer.getByText('Welcome, Browser.')).toBeVisible();

  const verify = await context.newPage();
  let confirmations = 0;
  verify.on('request', (request) => {
    if (request.url().endsWith('/verification/confirm')) confirmations++;
  });
  await verify.goto(verification);
  await browserExpect(verify).toHaveURL(`${config.webOrigin}/auth/verify-email`);
  expect(confirmations).toBe(0);
  expect((await store.users.findOne({ email }))?.emailVerifiedAt).toBeNull();
  await verify.getByRole('button', { name: 'Confirm email verification' }).click();
  await browserExpect(verify.getByText('Your email is verified.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh account status' }).click();
  await browserExpect(page.getByText('Your email is verified.', { exact: true })).toBeVisible();
  await verify.goto(verification);
  await verify.getByRole('button', { name: 'Confirm email verification' }).click();
  await browserExpect(verify.getByRole('alert')).toContainText('invalid or has expired');
  await verify.close();

  await page.clock.install();
  await peer.clock.install();
  await page.clock.fastForward((config.auth.accessTtl + 1) * 1000);
  await peer.clock.fastForward((config.auth.accessTtl + 1) * 1000);
  await Promise.all([
    page.getByRole('button', { name: 'Refresh account status' }).click(),
    peer.getByRole('button', { name: 'Refresh account status' }).click()
  ]);
  await browserExpect(page.getByRole('button', { name: 'Refresh account status' })).toBeEnabled();
  await browserExpect(peer.getByRole('button', { name: 'Refresh account status' })).toBeEnabled();
  await browserExpect(page.getByText('Welcome, Browser.')).toBeVisible();
  await browserExpect(peer.getByText('Welcome, Browser.')).toBeVisible();

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: resolve(artifactDirectory, `owner-${width}.png`),
      fullPage: true
    });
  }
  await noStoredCredentials(context);
  const recovery = await context.newPage();
  await recovery.goto(`${config.webOrigin}/auth/forgot-password`);
  await recovery.getByLabel('Email (required)', { exact: true }).fill(email);
  await recovery.getByRole('button', { name: 'Send reset link' }).click();
  await browserExpect(recovery.getByRole('status')).toContainText('If the account is eligible');
  const reset = await capturedLink('reset-password');
  await recovery.goto(reset);
  await browserExpect(recovery).toHaveURL(`${config.webOrigin}/auth/reset-password`);
  expect((await store.users.findOne({ email }))?.emailVerifiedAt).not.toBeNull();
  await recovery.getByLabel('New password (required)', { exact: true }).fill(replacement);
  await recovery.getByLabel('Confirm new password (required)', { exact: true }).fill(replacement);
  await recovery.getByRole('button', { name: 'Reset password', exact: true }).click();
  await browserExpect(recovery.getByRole('status')).toContainText('Your password has been reset.');
  await browserExpect(page).toHaveURL(/\/auth\/login/);
  await browserExpect(peer).toHaveURL(/\/auth\/login/);
  await page.goto(`${config.webOrigin}/auth/login`);
  await page.getByLabel('Email (required)', { exact: true }).fill(email);
  await page.getByLabel('Password (required)', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await browserExpect(page.getByRole('alert')).toContainText('Sign in failed');
  await signIn(page, replacement);
  await peer.goto(`${config.webOrigin}/owner`);
  await browserExpect(peer.getByText('Welcome, Browser.')).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await browserExpect(page).toHaveURL(`${config.webOrigin}/auth/login`);
  await browserExpect(peer).toHaveURL(/\/auth\/login/);
  await page.goto(`${config.webOrigin}/owner`);
  await browserExpect(page).toHaveURL(/\/auth\/login/);
  await noStoredCredentials(context);
  expect(runtimeErrors).toEqual([]);
  await context.close();
}, 120000);

it('keeps auth routes private, handles missing links and passes responsive form accessibility', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (const route of [
      'login',
      'register',
      'verification',
      'forgot-password',
      'verify-email',
      'reset-password'
    ]) {
      const result = await page.goto(`${config.webOrigin}/auth/${route}`);
      expect(result?.headers()['cache-control']).toBe('no-store');
      expect(result?.headers()['referrer-policy']).toBe('no-referrer');
      await browserExpect(page.locator('meta[name="robots"]')).toHaveAttribute(
        'content',
        'noindex, nofollow'
      );
      await browserExpect(page.locator('h1')).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
        true
      );
      if (route === 'register')
        await page.screenshot({
          path: resolve(artifactDirectory, `register-${width}.png`),
          fullPage: true
        });
    }
  }
  await page.goto(`${config.webOrigin}/auth/reset-password#token=bad`);
  await browserExpect(page).toHaveURL(`${config.webOrigin}/auth/reset-password`);
  await browserExpect(
    page.getByRole('button', { name: 'Reset password', exact: true })
  ).toHaveCount(0);
  await page.goto(`${config.webOrigin}/auth/callback`);
  await browserExpect(page.getByRole('alert')).toBeVisible();
  await page.goto(`${config.webOrigin}/auth/login?returnUrl=https://outside.example.test`);
  await page.getByLabel('Email (required)', { exact: true }).fill(email);
  await page.getByLabel('Password (required)', { exact: true }).fill(password);
  await page.route(`${config.public.apiBaseUrl}/auth/login`, (route) => route.abort());
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await browserExpect(page.getByRole('alert')).toContainText('service is unavailable');
  await browserExpect(page.getByLabel('Email (required)', { exact: true })).toHaveValue(email);
  await browserExpect(page.getByLabel('Password (required)', { exact: true })).toHaveValue(
    password
  );
  await page.unroute(`${config.public.apiBaseUrl}/auth/login`);
  await page.route(`${config.public.apiBaseUrl}/auth/login`, (route) =>
    route.fulfill({
      status: 429,
      headers: { 'Retry-After': '2' },
      contentType: 'application/json',
      body: '{}'
    })
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await browserExpect(page.getByRole('alert')).toContainText('Too many attempts');
  expect(new URL(page.url()).origin).toBe(config.webOrigin);
  expect(new URL(page.url()).pathname).toBe('/auth/login');
  await page.route(`${config.public.apiBaseUrl}/auth/google/start`, (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
  );
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await browserExpect(page.getByRole('alert')).toContainText('service is unavailable');
  await context.close();
}, 120000);

it('finishes the real Passport Google callback and refuses refresh retry loops', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route('https://accounts.google.com/**', async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state');
    await route.fulfill({
      status: 302,
      headers: {
        location: `${config.public.apiBaseUrl}/auth/google/callback?code=synthetic&state=${state}`
      }
    });
  });
  await page.goto(`${config.webOrigin}/auth/login`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await browserExpect(page).toHaveURL(`${config.webOrigin}/owner`);
  await browserExpect(page.getByText('Welcome, Browser.')).toBeVisible();
  expect((await store.users.findOne({ email: googleEmail }))?.passwordHash).toBeNull();
  let refreshes = 0;
  await page.route(`${config.public.apiBaseUrl}/auth/refresh`, (route) => {
    refreshes++;
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  });
  await page.reload();
  await browserExpect(page).toHaveURL(/\/auth\/login/);
  expect(refreshes).toBe(1);
  await browserExpect(page.getByRole('navigation', { name: 'Owner navigation' })).toHaveCount(0);
  await context.close();
});
