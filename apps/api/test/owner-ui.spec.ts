import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { chromium, expect as browserExpect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type {
  AdminListingDetail,
  MediaUploadResponse,
  OwnerListingDetail,
  OwnerListingPreview,
  OwnerMediaGallery
} from '@viedom/contracts';
import { loadConfig, root } from '../../../scripts/config.mjs';
import { localTarget } from '../src/database/local-target.js';
import { initializeOrm, ormOptions } from '../src/database/orm-options.js';
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
import { MediaModule } from '../src/media/media.module.js';
import { MediaAsset } from '../src/media/media.entities.js';
import { MediaWorker } from '../src/media/media.worker.js';
import { MediaStorage } from '../src/media/storage.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { ModerationDecision } from '../src/admin/moderation.entities.js';

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
let worker: MediaWorker;
let storage: MediaStorage;

beforeAll(async () => {
  if (config.mode === 'production') throw new Error('Owner smoke refuses production.');
  for (const url of [config.webOrigin, `${config.public.apiBaseUrl}/health`]) {
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => null))
      throw new Error('Stop applications on the configured web and API ports before owner smoke.');
  }
  const target = localTarget(config, true);
  orm = await initializeOrm(ormOptions(target.uri, target.dbName));
  await provision(orm);
  const module = await Test.createTestingModule({
    imports: [AuthModule, PropertiesModule, ListingsModule, MediaModule, AdminModule]
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
  worker = app.get(MediaWorker);
  storage = app.get(MediaStorage);
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
    await worker?.onModuleDestroy();
    const ids = accounts.map((user) => user._id);
    const sessions = await store.sessions.find({ userId: { $in: ids } }).toArray();
    const db = orm.em.getConnection().getDb();
    const assets = await orm.em.fork().find(MediaAsset, { ownerId: { $in: ids } });
    for (const asset of assets) {
      const keys = [
        asset.originalKey,
        ...asset.processingKeys,
        ...(asset.variants ? [asset.variants.large.key, asset.variants.thumbnail.key] : [])
      ];
      for (const key of new Set(keys)) await storage.remove(key);
    }
    await db.collection('moderation_decisions').deleteMany({ publisherId: { $in: ids } });
    await db.collection('media_assets').deleteMany({ ownerId: { $in: ids } });
    await db.collection('media_galleries').deleteMany({ ownerId: { $in: ids } });
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

async function account(verified = false, role: 'USER' | 'ADMIN' = 'USER'): Promise<User> {
  const user = Object.assign(new User(), {
    email: `${run}.${accounts.length}@example.invalid`,
    firstName: 'Browser',
    lastName: 'Owner',
    passwordHash,
    role,
    ...(verified ? { emailVerifiedAt: new Date() } : {})
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

async function gallery(user: User, id: string): Promise<OwnerMediaGallery> {
  const response = await request(user, `listings/${id}/media`);
  expect(response.status).toBe(200);
  return response.json();
}

async function imageFile(name: string, background = '#376a8f') {
  return {
    name,
    mimeType: 'image/jpeg',
    buffer: await sharp({ create: { width: 800, height: 600, channels: 3, background } })
      .withMetadata({ exif: { IFD0: { Artist: 'PRIVATE SYNTHETIC IMAGE METADATA' } } })
      .jpeg()
      .toBuffer()
  };
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
  await browserExpect(
    page.getByRole('heading', { name: 'Edit listing', exact: true })
  ).toBeVisible();
  await browserExpect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

async function noPersistentPrivateData(value: BrowserContext): Promise<void> {
  const storage = await value.storageState();
  expect(storage.origins.every((origin) => origin.localStorage.length === 0)).toBe(true);
  for (const page of value.pages())
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
}

async function submitForModeration(page: Page, user: User, title: string): Promise<string> {
  const id = await createDraft(page);
  await page.getByLabel('Title (optional for drafts)', { exact: true }).fill(title);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/listings/${id}`) && response.request().method() === 'PATCH'
  );
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await browserExpect(
    page.getByText('Listing saved. You can reopen it from My listings.', { exact: true })
  ).toBeVisible();
  await browserExpect(page.getByLabel('Title (optional for drafts)', { exact: true })).toHaveValue(
    title
  );
  await browserExpect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  const photos = page.getByRole('region', { name: 'Listing photos', exact: true });
  const picker = photos.getByLabel('Add photos', { exact: true });
  const file = await imageFile('moderation.jpg');
  await browserExpect(picker).toBeEnabled();
  try {
    const reservation = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/listings/${id}/media/upload-url`) &&
        response.request().method() === 'POST'
    );
    const completed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/listings/${id}/media/complete`) &&
        response.request().method() === 'POST'
    );
    await picker.setInputFiles(file);
    const [reserved, complete] = await Promise.all([reservation, completed]);
    expect(reserved.ok()).toBe(true);
    expect(complete.ok()).toBe(true);
    await browserExpect(photos.getByText('Ready', { exact: true })).toHaveCount(1, {
      timeout: 25000
    });
  } catch (error) {
    await page
      .screenshot({
        path: resolve(artifactDirectory, `moderation-upload-failed-${id}.png`),
        fullPage: true
      })
      .catch(() => undefined);
    const alerts = await page.getByRole('alert').allTextContents();
    const galleryState = await photos.innerText();
    throw new Error(
      `Moderation photo upload failed. Alerts: ${JSON.stringify(alerts)}. Gallery: ${galleryState}`,
      { cause: error }
    );
  }
  const submit = page.getByRole('button', { name: 'Submit for review', exact: true });
  await browserExpect(submit).toBeEnabled();
  await submit.click();
  await browserExpect(
    page.getByText('Submitted for review. Your listing is not published.', { exact: true })
  ).toBeVisible();
  expect((await detail(user, id)).status).toBe('pending_review');
  return id;
}

it('completes real owner submissions through administrator moderation and owner rejection feedback', async () => {
  const user = await account(true);
  const moderator = await account(true, 'ADMIN');
  const owning = await context();
  const reviewing = await context();
  let releaseApproval = () => {};
  try {
    const ownerPage = await owning.newPage();
    const adminPage = await reviewing.newPage();
    const errors: string[] = [];
    ownerPage.on('pageerror', (error) => errors.push(error.message));
    adminPage.on('pageerror', (error) => errors.push(error.message));
    await signIn(ownerPage, user);
    const approvedTitle = 'Synthetic approval browser apartment';
    const rejectedTitle = 'Synthetic rejection browser apartment';
    const approvedId = await submitForModeration(ownerPage, user, approvedTitle);
    const rejectedId = await submitForModeration(ownerPage, user, rejectedTitle);
    await signIn(adminPage, moderator);
    await adminPage.goto(`${config.webOrigin}/admin`);
    await browserExpect(
      adminPage.getByRole('heading', { name: 'Pending review', exact: true })
    ).toBeVisible();
    await browserExpect(
      adminPage.getByRole('button', { name: `Review listing: ${approvedTitle}`, exact: true })
    ).toBeVisible();
    await browserExpect(
      adminPage.getByRole('button', { name: `Review listing: ${rejectedTitle}`, exact: true })
    ).toBeVisible();
    await browserExpect(
      adminPage.getByRole('button', { name: 'Reload queue', exact: true })
    ).toBeEnabled();
    await adminPage.setViewportSize({ width: 375, height: 900 });
    await adminPage.screenshot({
      path: resolve(artifactDirectory, 'moderation-queue-mobile.png'),
      fullPage: true
    });
    expect((await new AxeBuilder({ page: adminPage }).analyze()).violations).toEqual([]);
    expect(await adminPage.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true
    );
    await adminPage
      .getByRole('button', { name: `Review listing: ${approvedTitle}`, exact: true })
      .click();
    await browserExpect(
      adminPage.getByRole('heading', { name: 'Review listing', exact: true })
    ).toBeVisible();
    await browserExpect(adminPage).toHaveURL(`${config.webOrigin}/admin/listings/${approvedId}`);
    await browserExpect(
      adminPage.getByRole('heading', { name: 'Review listing', exact: true })
    ).toBeFocused();
    await browserExpect(
      adminPage.getByText('PRIVATE SYNTHETIC COURTYARD 37', { exact: false })
    ).toBeVisible();
    await browserExpect(adminPage.getByRole('img')).toHaveCount(1);
    await browserExpect(adminPage.getByRole('img')).toHaveAttribute('src', /^blob:/);
    await adminPage.screenshot({
      path: resolve(artifactDirectory, 'moderation-review-mobile.png'),
      fullPage: true
    });
    expect((await new AxeBuilder({ page: adminPage }).analyze()).violations).toEqual([]);
    expect(await adminPage.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true
    );
    const representation = await request(moderator, `admin/listings/${approvedId}`);
    expect(representation.headers.get('cache-control')).toBe('no-store');
    const review: AdminListingDetail = await representation.json();
    expect(JSON.stringify(review)).not.toContain('originalKey');
    const privateImagePath = `admin/listings/${approvedId}/media/${review.media.items[0]!.id}/large`;
    const image = await request(moderator, privateImagePath);
    expect(image.status).toBe(200);
    expect(image.headers.get('cache-control')).toBe('no-store');
    expect(image.headers.get('content-type')).toBe('image/webp');
    const processed = Buffer.from(await image.arrayBuffer());
    expect((await sharp(processed).metadata()).exif).toBeUndefined();
    expect((await request(user, privateImagePath)).status).toBe(403);
    expect((await fetch(`${config.public.apiBaseUrl}/${privateImagePath}`)).status).toBe(401);
    expect((await request(moderator, `me/listings/${approvedId}`)).status).toBe(404);
    expect(
      (
        await fetch(
          `${config.public.apiBaseUrl}/media/${approvedId}/${review.media.items[0]!.id}/large`
        )
      ).status
    ).toBe(404);
    let approvals = 0;
    const gate = new Promise<void>((resolve) => (releaseApproval = resolve));
    await adminPage.route(
      `${config.public.apiBaseUrl}/admin/listings/${approvedId}/approve`,
      async (route) => {
        approvals++;
        await gate;
        await route.continue();
      }
    );
    await adminPage.getByRole('button', { name: 'Approve listing', exact: true }).click();
    const confirm = adminPage.getByRole('button', { name: 'Confirm approval', exact: true });
    try {
      await confirm.focus();
      await adminPage.keyboard.press('Enter');
      await browserExpect.poll(() => approvals).toBe(1);
      await browserExpect(confirm).toBeDisabled();
      await browserExpect(confirm).toHaveAttribute('aria-busy', 'true');
      await adminPage.keyboard.press('Enter');
      expect(approvals).toBe(1);
    } catch (error) {
      await adminPage
        .screenshot({
          path: resolve(artifactDirectory, 'moderation-approval-gate-failed.png'),
          fullPage: true
        })
        .catch(() => undefined);
      throw error;
    }
    releaseApproval();
    await browserExpect.poll(async () => (await detail(user, approvedId)).status).toBe('published');
    await browserExpect(
      adminPage.getByText('Listing approved and published.', { exact: true })
    ).toBeVisible();
    await browserExpect(
      adminPage.getByRole('button', { name: 'Reload queue', exact: true })
    ).toBeEnabled();
    expect(approvals).toBe(1);
    const approvedMedia = await gallery(user, approvedId);
    const publicImage = await fetch(
      `${config.public.apiBaseUrl}/media/${approvedId}/${approvedMedia.items[0]!.id}/large`
    );
    expect(publicImage.status).toBe(200);
    expect(publicImage.headers.get('content-type')).toBe('image/webp');

    await adminPage
      .getByRole('button', { name: `Review listing: ${rejectedTitle}`, exact: true })
      .click();
    await browserExpect(adminPage).toHaveURL(`${config.webOrigin}/admin/listings/${rejectedId}`);
    await browserExpect(
      adminPage
        .getByRole('region', { name: 'Review listing', exact: true })
        .getByRole('heading', { name: rejectedTitle, exact: true })
    ).toBeVisible();
    const reason =
      'Please describe the rooms. <img src=x onerror="window.moderationInjected=true">';
    await adminPage.getByLabel('Rejection reason', { exact: true }).fill(reason);
    await adminPage.getByRole('button', { name: 'Reject listing', exact: true }).click();
    await browserExpect(
      adminPage.getByRole('button', { name: 'Confirm rejection', exact: true })
    ).toBeVisible();
    await adminPage.screenshot({
      path: resolve(artifactDirectory, 'moderation-rejection-mobile.png'),
      fullPage: true
    });
    expect((await new AxeBuilder({ page: adminPage }).analyze()).violations).toEqual([]);
    try {
      const rejected = adminPage.waitForResponse(
        (response) =>
          response.url().endsWith(`/admin/listings/${rejectedId}/reject`) &&
          response.request().method() === 'POST'
      );
      await adminPage.getByRole('button', { name: 'Confirm rejection', exact: true }).click();
      const response = await rejected;
      expect(
        response.status(),
        `Rejection response status. Alerts: ${JSON.stringify(
          await adminPage.getByRole('alert').allTextContents()
        )}`
      ).toBe(200);
      await browserExpect(
        adminPage.getByText('Listing rejected. The owner can see your feedback.', { exact: true })
      ).toBeVisible();
    } catch (error) {
      await adminPage
        .screenshot({
          path: resolve(artifactDirectory, 'moderation-rejection-failed.png'),
          fullPage: true
        })
        .catch(() => undefined);
      const alerts = await adminPage.getByRole('alert').allTextContents();
      throw new Error(
        `Rejection was not confirmed. Alerts: ${JSON.stringify(alerts)}. Browser errors: ${JSON.stringify(errors)}`,
        { cause: error }
      );
    }
    await browserExpect.poll(async () => (await detail(user, rejectedId)).status).toBe('rejected');
    const rejectedMedia = await gallery(user, rejectedId);
    expect(
      (
        await fetch(
          `${config.public.apiBaseUrl}/media/${rejectedId}/${rejectedMedia.items[0]!.id}/large`
        )
      ).status
    ).toBe(404);
    await ownerPage.goto(`${config.webOrigin}/owner/listings/${rejectedId}`);
    await browserExpect(ownerPage.getByText('Changes requested', { exact: true })).toBeVisible();
    await browserExpect(ownerPage.getByText(reason, { exact: true })).toBeVisible();
    expect(await ownerPage.evaluate(() => Object.hasOwn(window, 'moderationInjected'))).toBe(false);
    await ownerPage.setViewportSize({ width: 375, height: 900 });
    await browserExpect(
      ownerPage.getByRole('button', { name: 'Refresh photos', exact: true })
    ).toBeEnabled();
    await ownerPage.screenshot({
      path: resolve(artifactDirectory, 'moderation-owner-reason-mobile.png'),
      fullPage: true
    });
    expect((await new AxeBuilder({ page: ownerPage }).analyze()).violations).toEqual([]);
    await ownerPage.goto(`${config.webOrigin}/owner`);
    await browserExpect(
      ownerPage
        .getByRole('region', { name: 'Review feedback', exact: true })
        .getByText(reason, { exact: true })
    ).toBeVisible();
    for (const id of [approvedId, rejectedId]) {
      const events = await orm.em.fork().find(ModerationDecision, { listingId: new ObjectId(id) });
      expect(events).toHaveLength(1);
      expect(events[0]!.reviewerId).toEqual(moderator._id);
    }
    await noPersistentPrivateData(owning);
    await noPersistentPrivateData(reviewing);
    await adminPage.getByRole('button', { name: 'Log out', exact: true }).click();
    await browserExpect(adminPage).toHaveURL(`${config.webOrigin}/auth/login`);
    await browserExpect(
      adminPage.getByText('PRIVATE SYNTHETIC COURTYARD 37', { exact: false })
    ).toHaveCount(0);
    await signIn(adminPage, user);
    await adminPage.goto(`${config.webOrigin}/admin/listings/${approvedId}`);
    await browserExpect(adminPage).toHaveURL(`${config.webOrigin}/owner`);
    await browserExpect(adminPage.getByText(moderator.email, { exact: false })).toHaveCount(0);
    await noPersistentPrivateData(reviewing);
    expect(errors).toEqual([]);
  } finally {
    releaseApproval();
    await owning.close();
    await reviewing.close();
  }
});

it('denies ordinary users the moderation route and makes stale reviews require reload', async () => {
  const user = await account(true);
  const moderator = await account(true, 'ADMIN');
  const owning = await context();
  const reviewing = await context();
  try {
    const ownerPage = await owning.newPage();
    const adminPage = await reviewing.newPage();
    await signIn(ownerPage, user);
    await ownerPage.goto(`${config.webOrigin}/admin`);
    await browserExpect(ownerPage).toHaveURL(`${config.webOrigin}/owner`);
    await browserExpect(
      ownerPage.getByRole('heading', { name: 'Pending review', exact: true })
    ).toHaveCount(0);
    const title = 'Synthetic stale moderation apartment';
    const id = await submitForModeration(ownerPage, user, title);
    await signIn(adminPage, moderator);
    await adminPage.goto(`${config.webOrigin}/admin`);
    await adminPage.getByRole('button', { name: `Review listing: ${title}`, exact: true }).click();
    await browserExpect(
      adminPage.getByRole('heading', { name: 'Review listing', exact: true })
    ).toBeVisible();
    const saved = await detail(user, id);
    expect(
      (
        await request(user, `listings/${id}`, 'PATCH', {
          transactionType: saved.transactionType,
          title: 'Changed while administrator was reviewing',
          description: saved.description,
          priceMinor: saved.priceMinor,
          currency: saved.currency,
          expectedVersion: saved.version
        })
      ).status
    ).toBe(200);
    await adminPage.getByRole('button', { name: 'Approve listing', exact: true }).click();
    const decision = adminPage.waitForResponse((response) =>
      response.url().endsWith(`/admin/listings/${id}/approve`)
    );
    await adminPage.getByRole('button', { name: 'Confirm approval', exact: true }).click();
    expect((await decision).status()).toBe(409);
    await browserExpect(adminPage.getByRole('alert')).toContainText(/reload/i);
    await browserExpect(
      adminPage.getByRole('button', { name: 'Approve listing', exact: true })
    ).toBeDisabled();
    expect((await detail(user, id)).status).toBe('draft');
    expect(await orm.em.fork().count(ModerationDecision, { listingId: new ObjectId(id) })).toBe(0);
  } finally {
    await owning.close();
    await reviewing.close();
  }
});

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
    await browserExpect(
      page.getByRole('button', { name: 'Submit for review', exact: true })
    ).toBeDisabled();

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

it('uploads private photos, edits the gallery by keyboard, previews safe fields and submits once for review', async () => {
  const user = await account(true);
  const other = await account(true);
  const browsing = await context();
  let releasePut = () => {};
  let releaseSubmit = () => {};
  try {
    const page = await browsing.newPage();
    const errors: string[] = [];
    const authorizations: Promise<MediaUploadResponse>[] = [];
    let successfulPuts = 0;
    const storageCredentials: {
      authorization: string | undefined;
      cookie: string | undefined;
    }[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.url().endsWith('/media/upload-url') && response.ok())
        authorizations.push(response.json());
      if (response.request().method() === 'PUT' && response.ok()) successfulPuts++;
    });
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'PUT') {
        const { authorization, cookie } = outgoing.headers();
        storageCredentials.push({ authorization, cookie });
      }
    });
    await signIn(page, user);
    const id = await createDraft(page);
    const photos = page.getByRole('region', { name: 'Listing photos', exact: true });
    const cards = photos.getByRole('list', { name: 'Listing photo gallery', exact: true });
    worker.stop();
    const putGate = new Promise<void>((resolve) => (releasePut = resolve));
    let gated = false;
    await page.route(
      (url) => url.origin === new URL(config.storage.endpoint).origin,
      async (route) => {
        if (route.request().method() === 'PUT' && !gated) {
          gated = true;
          await putGate;
        }
        await route.continue();
      }
    );
    const picker = photos.getByLabel('Add photos', { exact: true });
    await browserExpect(picker).toBeEnabled();
    await picker.setInputFiles([
      await imageFile('courtyard.jpg'),
      await imageFile('kitchen.jpg', '#406842'),
      await imageFile('balcony.jpg', '#91592c')
    ]);
    await browserExpect(
      photos.getByRole('progressbar', { name: 'Uploading courtyard.jpg', exact: true })
    ).toBeVisible();
    await browserExpect(
      page.getByRole('button', { name: 'Submit for review', exact: true })
    ).toBeDisabled();
    releasePut();
    await browserExpect(cards.getByText('Queued for processing', { exact: true })).toHaveCount(3);
    expect(successfulPuts).toBe(3);
    expect(storageCredentials).toEqual([
      { authorization: undefined, cookie: undefined },
      { authorization: undefined, cookie: undefined },
      { authorization: undefined, cookie: undefined }
    ]);
    const uploaded = await Promise.all(authorizations);
    expect(uploaded.length).toBe(3);
    const queued = await gallery(user, id);
    expect(queued.items.map((item) => item.state)).toEqual(['queued', 'queued', 'queued']);
    expect((await detail(user, id)).submission.missing).toContain('processedMedia');
    const queuedPreview = page.waitForResponse((response) =>
      response.url().endsWith(`/me/listings/${id}/preview`)
    );
    await page.getByRole('button', { name: 'Preview saved listing', exact: true }).click();
    const queuedRepresentation: OwnerListingPreview = await (await queuedPreview).json();
    expect(queuedRepresentation.content.media.items).toEqual([]);
    const serialized = JSON.stringify(queuedRepresentation);
    for (const privateValue of [
      'PRIVATE SYNTHETIC COURTYARD 37',
      '22.954321',
      '40.643219',
      'privateLocation',
      'originalKey',
      'uploadUrl'
    ])
      expect(serialized).not.toContain(privateValue);
    for (const authorization of uploaded) {
      const original = new URL(authorization.uploadUrl);
      original.search = '';
      expect((await fetch(original)).ok).toBe(false);
      expect(
        (await fetch(`${config.public.apiBaseUrl}/media/${id}/${authorization.mediaId}/large`))
          .status
      ).toBe(404);
    }
    const previewEndpoint = `${config.public.apiBaseUrl}/me/listings/${id}/preview`;
    expect((await fetch(previewEndpoint)).status).toBe(401);
    expect((await request(other, `me/listings/${id}/preview`)).status).toBe(404);
    worker.onModuleInit();
    await browserExpect(cards.getByText('Ready', { exact: true })).toHaveCount(3, {
      timeout: 25000
    });
    await page.setViewportSize({ width: 375, height: 900 });
    const move = photos.getByRole('button', { name: 'Move earlier: photo 3', exact: true });
    const reorder = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/listings/${id}/media`) && response.request().method() === 'PATCH'
    );
    await move.focus();
    await page.keyboard.press('Enter');
    expect((await reorder).ok()).toBe(true);
    expect((await gallery(user, id)).items.map((item) => item.id)).toEqual([
      queued.items[0]!.id,
      queued.items[2]!.id,
      queued.items[1]!.id
    ]);
    const cover = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/listings/${id}/media`) && response.request().method() === 'PATCH'
    );
    await photos.getByRole('button', { name: 'Use as cover: photo 2', exact: true }).click();
    expect((await cover).ok()).toBe(true);
    expect((await gallery(user, id)).coverMediaId).toBe(queued.items[2]!.id);
    const deleted = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/media/${queued.items[1]!.id}`) &&
        response.request().method() === 'DELETE'
    );
    await photos.getByRole('button', { name: 'Delete photo 3', exact: true }).click();
    expect((await deleted).ok()).toBe(true);
    await browserExpect(cards.getByRole('listitem')).toHaveCount(2);
    expect((await gallery(user, id)).items.map((item) => item.id)).toEqual([
      queued.items[0]!.id,
      queued.items[2]!.id
    ]);
    const previewResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/me/listings/${id}/preview`)
    );
    await page.getByRole('button', { name: 'Preview saved listing', exact: true }).click();
    const response = await previewResponse;
    expect(response.headers()['cache-control']).toBe('no-store');
    const representation: OwnerListingPreview = await response.json();
    expect(representation.status).toBe('draft');
    expect(representation.content.media.items.map((item) => item.id)).toEqual([
      queued.items[0]!.id,
      queued.items[2]!.id
    ]);
    const preview = page.getByRole('region', { name: 'Private listing preview', exact: true });
    await browserExpect(
      preview.getByRole('heading', { name: 'Private listing preview' })
    ).toBeVisible();
    await browserExpect(preview.getByRole('img')).toHaveCount(2);
    const previewText = await preview.innerText();
    expect(previewText).not.toContain('PRIVATE SYNTHETIC COURTYARD 37');
    expect(previewText).not.toContain('22.954321');
    expect(previewText).not.toContain('40.643219');
    expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: resolve(artifactDirectory, 'photos-preview-mobile.png'),
      fullPage: true
    });
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
    await browserExpect(
      page.getByRole('button', { name: 'Preview saved listing', exact: true })
    ).toBeFocused();

    let submissions = 0;
    const submitGate = new Promise<void>((resolve) => (releaseSubmit = resolve));
    await page.route(`${config.public.apiBaseUrl}/listings/${id}/submit`, async (route) => {
      submissions++;
      await submitGate;
      await route.continue();
    });
    const submit = page.getByRole('button', { name: 'Submit for review', exact: true });
    await browserExpect(submit).toBeEnabled();
    await submit.focus();
    await page.keyboard.press('Enter');
    await browserExpect(submit).toBeDisabled();
    await browserExpect.poll(() => submissions).toBe(1);
    await page.keyboard.press('Enter');
    expect(submissions).toBe(1);
    releaseSubmit();
    await browserExpect(
      page.getByText('Submitted for review. Your listing is not published.', { exact: true })
    ).toBeVisible();
    const submitted = await detail(user, id);
    expect(submitted.status).toBe('pending_review');
    expect(submitted.publishedAt).toBeNull();
    expect(submitted.submittedVersion).toBe(submitted.version);
    expect(submissions).toBe(1);
    for (const item of representation.content.media.items)
      expect((await fetch(`${config.public.apiBaseUrl}/media/${id}/${item.id}/large`)).status).toBe(
        404
      );
    await noPersistentPrivateData(browsing);
    expect(errors).toEqual([]);
  } finally {
    releasePut();
    releaseSubmit();
    if (worker) {
      worker.stop();
      worker.onModuleInit();
    }
    await browsing.close();
  }
});

it('recovers a failed storage upload and keeps invalid processed images out of submission', async () => {
  const user = await account(true);
  const browsing = await context();
  try {
    const page = await browsing.newPage();
    await signIn(page, user);
    const id = await createDraft(page);
    const photos = page.getByRole('region', { name: 'Listing photos', exact: true });
    const picker = photos.getByLabel('Add photos', { exact: true });
    let interrupted = false;
    await page.route(
      (url) => url.origin === new URL(config.storage.endpoint).origin,
      async (route) => {
        if (route.request().method() === 'PUT' && !interrupted) {
          interrupted = true;
          await route.abort('connectionfailed');
        } else await route.continue();
      }
    );
    await browserExpect(picker).toBeEnabled();
    await picker.setInputFiles(await imageFile('retry-courtyard.jpg'));
    const retry = photos.getByRole('button', { name: 'Retry upload: photo 1', exact: true });
    await browserExpect(retry).toBeVisible();
    expect(interrupted).toBe(true);
    await retry.click();
    await browserExpect(photos.getByText('Ready', { exact: true })).toHaveCount(1, {
      timeout: 20000
    });
    expect((await gallery(user, id)).items).toHaveLength(1);
    await picker.setInputFiles({
      name: 'invalid-image.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('Synthetic text pretending to be a JPEG image.')
    });
    await browserExpect(photos.getByText(/^Photo failed:/)).toBeVisible({
      timeout: 20000
    });
    const failed = await gallery(user, id);
    expect(failed.items.map((item) => item.state)).toEqual(['ready', 'failed']);
    expect((await detail(user, id)).submission.missing).toContain('processedMedia');
    await browserExpect(
      page.getByRole('button', { name: 'Submit for review', exact: true })
    ).toBeDisabled();
    const previewResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/me/listings/${id}/preview`)
    );
    await page.getByRole('button', { name: 'Preview saved listing', exact: true }).click();
    const preview: OwnerListingPreview = await (await previewResponse).json();
    expect(preview.content.media.items.map((item) => item.id)).toEqual([failed.items[0]!.id]);
    const previewPanel = page.getByRole('region', {
      name: 'Private listing preview',
      exact: true
    });
    await browserExpect(previewPanel.getByRole('img')).toHaveCount(1);
    await previewPanel.getByRole('button', { name: 'Close preview', exact: true }).click();
    await browserExpect(previewPanel).toHaveCount(0);
    await photos.getByRole('button', { name: 'Delete photo 2', exact: true }).click();
    await browserExpect(photos.getByText(/^Photo failed:/)).toHaveCount(0);
    await browserExpect(
      page.getByRole('button', { name: 'Submit for review', exact: true })
    ).toBeEnabled();
    expect((await detail(user, id)).status).toBe('draft');
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
