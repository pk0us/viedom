import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { chromium, expect as browserExpect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { OwnerListingDetail } from '@viedom/contracts';
import { loadConfig, root } from '../../../scripts/config.mjs';
import { localTarget } from '../src/database/local-target.js';
import { ormOptions } from '../src/database/orm-options.js';
import { provision } from '../src/database/provision.js';
import { Listing, Property, User } from '../src/database/entities.js';
import { Configuration } from '../src/configuration.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthActions } from '../src/auth/auth.actions.js';
import { AuthStore } from '../src/auth/auth.store.js';
import { AuthService } from '../src/auth/auth.service.js';
import { digest, Passwords } from '../src/auth/auth.crypto.js';
import { PropertiesModule } from '../src/properties/properties.module.js';
import { ListingsModule } from '../src/listings/listings.module.js';
import { ApiErrorFilter } from '../src/api-error.filter.js';
import { propertySnapshot } from '../src/database/snapshots.js';

const config = loadConfig();
const run = randomUUID();
const password = 'Synthetic owner browser password';
const artifactDirectory = resolve(root, 'test-results/owner-ui');
const rateIds = new Set<string>();
const accounts: User[] = [];
let orm: MikroORM;
let store: AuthStore;
let app: INestApplication;
let web: ChildProcess;
let browser: Browser;
let passwordHash: string;

beforeAll(async () => {
  if (config.mode === 'production') throw new Error('Owner smoke refuses production.');
  for (const url of [config.webOrigin, `${config.public.apiBaseUrl}/health`]) {
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => null))
      throw new Error('Stop applications on the configured web and API ports before owner smoke.');
  }
  const target = localTarget(config, true);
  orm = await MikroORM.init(ormOptions(target.uri, target.dbName));
  await provision(orm);
  const module = await Test.createTestingModule({
    imports: [AuthModule, PropertiesModule, ListingsModule]
  })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .overrideProvider(CoreMikroORM)
    .useValue(orm)
    .overrideProvider(Configuration)
    .useValue({ values: config })
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
    const owned = `${run}:${key}`;
    rateIds.add(digest(`${scope}:${owned}:${Math.floor(Date.now() / (seconds * 1000))}`));
    return limit(scope, owned, maximum, seconds);
  });
  passwordHash = await app.get(Passwords).hash(password);
  await app.listen(config.ports.api, '127.0.0.1');
  await app.get(AuthActions).onModuleDestroy();
  web = spawn(process.execPath, ['dist/web/server/server.mjs'], {
    cwd: resolve(root, 'apps/web'),
    stdio: 'ignore',
    env: { ...process.env, PORT: String(config.ports.web) },
    windowsHide: true
  });
  await vi.waitFor(
    async () => {
      expect((await fetch(config.webOrigin, { signal: AbortSignal.timeout(1000) })).ok).toBe(true);
    },
    { timeout: 20000, interval: 200 }
  );
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
  if (orm && store) {
    const ids = accounts.map((user) => user._id);
    const sessions = await store.sessions.find({ userId: { $in: ids } }).toArray();
    const db = orm.em.getConnection().getDb();
    await db.collection('listings').deleteMany({ publisherId: { $in: ids } });
    await db.collection('properties').deleteMany({ ownerId: { $in: ids } });
    await store.actions.deleteMany({ userId: { $in: ids } });
    await store.deliveries.deleteMany({ userId: { $in: ids } });
    await store.tokens.deleteMany({ sessionId: { $in: sessions.map((session) => session._id) } });
    await store.sessions.deleteMany({ userId: { $in: ids } });
    await store.identities.deleteMany({ userId: { $in: ids } });
    await store.users.deleteMany({ _id: { $in: ids } });
    await store.rates.deleteMany({ _id: { $in: [...rateIds] } });
  }
  await app?.close();
  await orm?.close(true);
});

async function account(): Promise<User> {
  const user = Object.assign(new User(), {
    email: `${run}.${accounts.length}@example.invalid`,
    firstName: 'Browser',
    lastName: 'Owner',
    passwordHash
  });
  accounts.push(user);
  const em = orm.em.fork();
  em.persist(user);
  await em.flush();
  return user;
}

async function context(): Promise<BrowserContext> {
  const result = await browser.newContext();
  await result.route(
    (url) =>
      ['http:', 'https:'].includes(url.protocol) &&
      !['localhost', '127.0.0.1'].includes(url.hostname),
    (route) => route.abort()
  );
  return result;
}

async function signIn(page: Page, user: User): Promise<void> {
  await page.goto(`${config.webOrigin}/auth/login`);
  await page.getByLabel('Email (required)', { exact: true }).fill(user.email);
  await page.getByLabel('Password (required)', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await browserExpect(page).toHaveURL(`${config.webOrigin}/owner`);
  await browserExpect(page.getByText('Welcome, Browser.')).toBeVisible();
}

async function request(
  user: User,
  path: string,
  method = 'GET',
  body?: unknown
): Promise<Response> {
  const session = await store.create({ user }, config.auth.refreshTtl);
  const { accessToken } = await app.get(AuthService).response(session);
  return fetch(`${config.public.apiBaseUrl}/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function detail(user: User, id: string): Promise<OwnerListingDetail> {
  const response = await request(user, `me/listings/${id}`);
  expect(response.status).toBe(200);
  return response.json();
}

async function fillDraft(page: Page, title = 'Synthetic courtyard apartment'): Promise<void> {
  await page.getByLabel('Property type', { exact: true }).selectOption('apartment');
  for (const [label, value] of [
    ['Area (m²)', '87.5'],
    ['Bedrooms', '2'],
    ['Bathrooms', '1'],
    ['Floor', '3'],
    ['Year built (optional)', '2004'],
    ['City', 'Thessaloniki'],
    ['Neighborhood (optional)', 'Synthetic quarter'],
    ['Street address (private, optional)', 'PRIVATE SYNTHETIC COURTYARD 37'],
    ['Private longitude', '22.954321'],
    ['Private latitude', '40.643219'],
    ['Title (optional for drafts)', title],
    [
      'Description (optional for drafts)',
      'A synthetic apartment description without real contact details.'
    ],
    ['Price (EUR)', '765.43']
  ])
    await page.getByLabel(label!, { exact: true }).fill(value!);
  await page.getByRole('button', { name: 'Add amenity', exact: true }).click();
  await page.getByLabel('Amenity 1', { exact: true }).fill('lift');
  await page.getByRole('button', { name: 'Add amenity', exact: true }).click();
  await page.getByLabel('Amenity 2', { exact: true }).fill('balcony');
  await page.getByLabel('Listing type', { exact: true }).selectOption('rent');
}

async function createDraft(page: Page): Promise<string> {
  if (new URL(page.url()).pathname !== '/owner/listings/new')
    await page.goto(`${config.webOrigin}/owner/listings/new`);
  await fillDraft(page);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await browserExpect(page).toHaveURL(/\/owner\/listings\/[a-f0-9]{24}$/);
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

async function noPersistentPrivateData(value: BrowserContext): Promise<void> {
  const storage = await value.storageState();
  expect(storage.origins.every((origin) => origin.localStorage.length === 0)).toBe(true);
  for (const page of value.pages())
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
}

it('saves, reopens and edits exact draft values on desktop and mobile without public readiness', async () => {
  const user = await account();
  const browsing = await context();
  try {
    const page = await browsing.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await signIn(page, user);
    const id = await createDraft(page);
    await browserExpect(page.getByText('The map could not load.', { exact: false })).toBeVisible();
    const saved = await detail(user, id);
    expect(saved.status).toBe('draft');
    expect(saved.priceMinor).toBe(76543);
    expect(saved.property.details).toEqual({
      areaM2: 87.5,
      bedrooms: 2,
      bathrooms: 1,
      floor: 3,
      yearBuilt: 2004,
      amenities: ['lift', 'balcony']
    });
    expect(saved.property.address.street).toBe('PRIVATE SYNTHETIC COURTYARD 37');
    expect(saved.property.privateLocation.coordinates).toEqual([22.954321, 40.643219]);
    expect(saved.submission.canSubmit).toBe(false);
    expect(saved.submission.missing).toContain('processedMedia');
    expect(saved.submission.missing).toContain('verifiedEmail');
    await page.reload();
    await browserExpect(page.getByLabel('Price (EUR)', { exact: true })).toHaveValue('765.43');
    await browserExpect(page.getByLabel('Private longitude', { exact: true })).toHaveValue(
      '22.954321'
    );
    await browserExpect(
      page.getByLabel('Street address (private, optional)', { exact: true })
    ).toHaveValue('PRIVATE SYNTHETIC COURTYARD 37');
    await browserExpect(page.getByRole('button', { name: /submit|publish/i })).toHaveCount(0);

    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
        true
      );
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: resolve(artifactDirectory, `editor-${width}.png`),
        fullPage: true
      });
    }

    await page.setViewportSize({ width: 375, height: 900 });
    await page.getByLabel('Area (m²)', { exact: true }).fill('91.25');
    await page.getByLabel('Price (EUR)', { exact: true }).fill('900.01');
    await page
      .getByLabel('Title (optional for drafts)', { exact: true })
      .fill('Updated synthetic apartment');
    const update = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/listings/${id}`) && response.request().method() === 'PATCH'
    );
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    expect((await update).ok()).toBe(true);
    await browserExpect(
      page.getByRole('button', { name: 'Save draft', exact: true })
    ).toBeEnabled();
    await page.reload();
    await browserExpect(page.getByLabel('Area (m²)', { exact: true })).toHaveValue('91.25');
    await browserExpect(page.getByLabel('Price (EUR)', { exact: true })).toHaveValue('900.01');
    const edited = await detail(user, id);
    expect(edited.property.version).toBe(saved.property.version + 1);
    expect(edited.priceMinor).toBe(90001);
    expect(edited.title).toBe('Updated synthetic apartment');
    const response = await fetch(`${config.webOrigin}/owner/listings/${id}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await response.text();
    expect(html).not.toContain(saved.property.address.street);
    expect(html).not.toContain('22.954321');
    expect(html).not.toContain('Updated synthetic apartment');
    await noPersistentPrivateData(browsing);
    expect(errors).toEqual([]);
  } finally {
    await browsing.close();
  }
});

it('loads the browser map worker and persists a manually selected private pin', async () => {
  const user = await account();
  const browsing = await context();
  try {
    const page = await browsing.newPage();
    await page.route(config.public.map.styleUrl, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 8,
          sources: {},
          layers: [
            { id: 'background', type: 'background', paint: { 'background-color': '#eaf2fc' } }
          ]
        })
      })
    );
    const worker = page.waitForResponse((response) =>
      response.url().includes('/maplibre/maplibre-gl-worker.mjs')
    );
    await signIn(page, user);
    await page.goto(`${config.webOrigin}/owner/listings/new`);
    await fillDraft(page);
    const canvas = page.getByLabel(
      'Property location map. Use coordinate fields for keyboard location entry.',
      { exact: true }
    );
    await browserExpect(canvas).toBeVisible();
    await browserExpect(page.getByRole('button', { name: 'Center on private pin' })).toBeVisible();
    expect((await worker).ok()).toBe(true);
    await page.getByRole('button', { name: 'Center on private pin' }).click();
    const size = await canvas.boundingBox();
    expect(size).not.toBeNull();
    await canvas.click({ position: { x: size!.width * 0.7, y: size!.height * 0.4 } });
    await browserExpect(page.getByLabel('Private longitude', { exact: true })).not.toHaveValue(
      '22.954321'
    );
    await browserExpect(page.getByLabel('Private latitude', { exact: true })).not.toHaveValue(
      '40.643219'
    );
    const longitude = Number(
      await page.getByLabel('Private longitude', { exact: true }).inputValue()
    );
    const latitude = Number(
      await page.getByLabel('Private latitude', { exact: true }).inputValue()
    );
    expect(longitude).not.toBe(22.954321);
    expect(latitude).not.toBe(40.643219);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await browserExpect(page).toHaveURL(/\/owner\/listings\/[a-f0-9]{24}$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    const saved = await detail(user, id);
    expect(saved.property.privateLocation.coordinates).toEqual([longitude, latitude]);
    expect(saved.property.publicLocation.coordinates).not.toEqual([longitude, latitude]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: resolve(artifactDirectory, 'location-picker.png'),
      fullPage: true
    });
  } finally {
    await browsing.close();
  }
});

it('paginates owner cards, filters statuses and confirms pause and terminal archive', async () => {
  const user = await account();
  const browsing = await context();
  try {
    const page = await browsing.newPage();
    await signIn(page, user);
    const id = await createDraft(page);
    const saved = await detail(user, id);
    const em = orm.em.fork();
    const canonical = await em.findOneOrFail(Property, new ObjectId(saved.property.id));
    for (let index = 0; index < 21; index++) {
      const item = Object.assign(new Listing(), {
        propertyId: canonical._id,
        publisherId: user._id,
        title: `Synthetic paginated listing ${index}`,
        slug: `synthetic-paginated-listing-${index}`,
        description: 'Synthetic owner pagination browser fixture.',
        priceMinor: 50000 + index,
        createdAt: new Date(Date.now() + index * 1000),
        status: index === 20 ? 'published' : 'draft',
        ...propertySnapshot(canonical)
      });
      em.persist(item);
    }
    await em.flush();
    await page.goto(`${config.webOrigin}/owner`);
    await browserExpect(page.getByRole('article')).toHaveCount(20);
    await page.getByRole('button', { name: /load more/i }).click();
    await browserExpect(page.getByRole('article')).toHaveCount(22);
    await page.getByLabel('Listing status', { exact: true }).selectOption('published');
    await browserExpect(page.getByRole('article')).toHaveCount(1);
    const card = page.getByRole('article').filter({ hasText: 'Synthetic paginated listing 20' });
    await card.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm pause', exact: true }).click();
    await browserExpect(page.getByRole('article')).toHaveCount(0);
    await page.getByLabel('Listing status', { exact: true }).selectOption('paused');
    await browserExpect(page.getByRole('article')).toHaveCount(1);
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(page.getByRole('article')).toHaveCount(1);
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm archive', exact: true }).click();
    await browserExpect(page.getByRole('article')).toHaveCount(0);
    await page.getByLabel('Listing status', { exact: true }).selectOption('archived');
    await browserExpect(page.getByRole('article')).toHaveCount(1);
    await browserExpect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 375, height: 900 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true
    );
    await page.screenshot({
      path: resolve(artifactDirectory, 'dashboard-mobile.png'),
      fullPage: true
    });
  } finally {
    await browsing.close();
  }
});

it('validates inputs, confirms unsaved navigation, requires conflict reload and denies another owner', async () => {
  const user = await account();
  const other = await account();
  const browsing = await context();
  const otherBrowsing = await context();
  try {
    const page = await browsing.newPage();
    await signIn(page, user);
    await page.goto(`${config.webOrigin}/owner/listings/new`);
    await page.getByLabel('Area (m²)', { exact: true }).fill('0');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await browserExpect(page.getByLabel('Area (m²)', { exact: true })).toBeFocused();
    expect(await orm.em.fork().count(Property, { ownerId: user._id })).toBe(0);
    const id = await createDraft(page);
    await page.getByLabel('Price (EUR)', { exact: true }).fill('800.002');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await browserExpect(page.getByLabel('Price (EUR)', { exact: true })).toBeFocused();
    expect((await detail(user, id)).priceMinor).toBe(76543);
    await page.getByLabel('Price (EUR)', { exact: true }).fill('800.02');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('link', { name: 'My listings', exact: true }).first().click();
    await browserExpect(page).toHaveURL(`${config.webOrigin}/owner/listings/${id}`);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('link', { name: 'My listings', exact: true }).first().click();
    await browserExpect(page).toHaveURL(`${config.webOrigin}/owner`);
    await page.goto(`${config.webOrigin}/owner/listings/${id}`);
    await browserExpect(page.getByLabel('Price (EUR)', { exact: true })).toHaveValue('765.43');

    const current = await detail(user, id);
    const changed = await request(user, `listings/${id}`, 'PATCH', {
      transactionType: current.transactionType,
      title: 'Changed in another browser',
      description: current.description,
      priceMinor: current.priceMinor,
      currency: 'EUR',
      expectedVersion: current.version
    });
    expect(changed.ok).toBe(true);
    await page.getByLabel('Title (optional for drafts)', { exact: true }).fill('My unsaved title');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await browserExpect(page.getByRole('alert')).toContainText('Reload');
    await browserExpect(
      page.getByLabel('Title (optional for drafts)', { exact: true })
    ).toHaveValue('My unsaved title');
    await browserExpect(
      page.getByRole('button', { name: 'Save draft', exact: true })
    ).toBeDisabled();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Reload saved listing', exact: true }).click();
    await browserExpect(
      page.getByLabel('Title (optional for drafts)', { exact: true })
    ).toHaveValue('Changed in another browser');

    const stranger = await otherBrowsing.newPage();
    await signIn(stranger, other);
    const denied = stranger.waitForResponse((response) =>
      response.url().endsWith(`/me/listings/${id}`)
    );
    await stranger.goto(`${config.webOrigin}/owner/listings/${id}`);
    expect((await denied).status()).toBe(404);
    await browserExpect(stranger.getByRole('alert')).toBeVisible();
    await browserExpect(
      stranger.getByLabel('Street address (private, optional)', { exact: true })
    ).toHaveCount(0);
    await noPersistentPrivateData(browsing);
  } finally {
    await browsing.close();
    await otherBrowsing.close();
  }
});
