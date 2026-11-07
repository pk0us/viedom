import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URLSearchParams } from 'node:url';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadConfig, root } from './config.mjs';
import { stopChild } from './process.mjs';

const config = loadConfig();
if (config.mode === 'production') throw new Error('Local search UI smoke refuses production.');
const origin = config.webOrigin;
const api = new URL(config.public.apiBaseUrl);
const directory = resolve(root, 'test-results/search-ui');
const [longitude, latitude] = [config.public.map.longitude, config.public.map.latitude];
const bounds = {
  west: longitude - 0.1,
  south: latitude - 0.08,
  east: longitude + 0.1,
  north: latitude + 0.08
};
const initialUrl = `${origin}/search?${new URLSearchParams(bounds)}`;
const thumbnailUrl = `${api.origin}/api/media/search-smoke-thumbnail.webp`;
const id = (value) => value.toString(16).padStart(24, '0');
const marker = (value, offset = 0) => ({
  id: id(value),
  transactionType: 'rent',
  priceMinor: 75000 + value * 100,
  currency: 'EUR',
  publicLocation: { type: 'Point', coordinates: [longitude + offset, latitude] },
  locationPrecision: 'approximate'
});
const card = (value, title, offset = 0) => ({
  ...marker(value, offset),
  title,
  slug: `search-smoke-${value}`,
  propertyType: 'apartment',
  areaM2: 85,
  bedrooms: 2,
  bathrooms: 1,
  city: config.public.city,
  neighborhood: 'City centre',
  publishedAt: '2026-11-01T10:00:00.000Z',
  coverImage: { url: thumbnailUrl, width: 480, height: 320, bytes: 100, contentType: 'image/webp' }
});
const firstCards = [
  card(1, 'Sunny city apartment', -0.065),
  card(2, 'Calm garden apartment', 0.065)
];
const laterCard = card(3, 'Next page apartment', 0.03);
const markers = [
  marker(1, -0.065),
  marker(2, 0.065),
  ...Array.from({ length: 498 }, (_, index) => marker(index + 10, (index % 5) * 0.00001))
];
const requests = [];
const errors = [];
const results = [];
const pending = [];
let scenario = 'normal';
let tileFailure = false;
let browser;
let server;
let page;

async function waitForServer() {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          return false;
        }
      },
      { timeout: 20000 }
    )
    .toBe(true);
}

const headers = {
  'access-control-allow-origin': origin,
  'cache-control': 'no-store'
};

async function respond(route, currentScenario = scenario) {
  const url = new URL(route.request().url());
  const isCards = url.pathname === `${api.pathname}/listings/search`;
  if (currentScenario === 'error' || (currentScenario === 'markers-error' && !isCards)) {
    await route.fulfill({
      status: 503,
      headers,
      json: {
        error: { code: 'unavailable', message: 'Search unavailable', requestId: 'search-ui-smoke' }
      }
    });
    return;
  }
  const items =
    currentScenario === 'empty'
      ? []
      : isCards
        ? url.searchParams.has('cursor')
          ? [laterCard]
          : firstCards
        : markers;
  await route.fulfill({
    headers,
    json: isCards
      ? {
          items,
          nextCursor:
            currentScenario === 'empty' || url.searchParams.has('cursor')
              ? null
              : 'synthetic-next-page'
        }
      : { items, capped: currentScenario !== 'empty', limit: 500 }
  });
}

async function assertCards(page, count = 2) {
  await expect(page.getByRole('article')).toHaveCount(count);
  await expect(page.getByRole('heading', { name: firstCards[0].title, exact: true })).toBeVisible();
}

async function checkLayout(page, width, mode = 'list') {
  assert.equal(
    await page.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    `${width}px ${mode} must not overflow`
  );
  const accessibility = await new AxeBuilder({ page }).analyze();
  results.push({ width, mode, violations: accessibility.violations });
  await writeFile(resolve(directory, 'accessibility.json'), JSON.stringify(results, null, 2));
  assert.deepEqual(
    accessibility.violations.map(({ id: violation }) => violation),
    [],
    `${width}px ${mode} axe`
  );
  await page.screenshot({ path: resolve(directory, `${mode}-${width}.png`), fullPage: true });
}

async function apply(page, value) {
  await page.getByLabel('Maximum price (€)', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('maxPrice') === String(Number(value) * 100)
  );
}

await mkdir(directory, { recursive: true });
try {
  server = spawn(process.execPath, ['dist/web/server/server.mjs'], {
    cwd: resolve(root, 'apps/web'),
    stdio: 'inherit',
    env: { ...process.env, PORT: String(config.ports.web) }
  });
  server.once('error', (error) => errors.push(error.message));
  await waitForServer();
  const html = await (await fetch(initialUrl)).text();
  assert.ok(!html.includes('maplibregl-canvas'), 'SSR must not initialize WebGL resources');
  browser = await chromium.launch({
    channel:
      process.env.SMOKE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
    headless: true,
    args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce'
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(
    (url) =>
      url.origin === api.origin &&
      [`${api.pathname}/listings/search`, `${api.pathname}/listings/markers`].includes(
        url.pathname
      ),
    async (route) => {
      const url = new URL(route.request().url());
      assert.equal(route.request().method(), 'GET');
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
      if (url.pathname.endsWith('/markers')) {
        assert.equal(url.searchParams.has('cursor'), false);
        assert.equal(url.searchParams.has('limit'), false);
      }
      if (scenario === 'pending') pending.push(route);
      else await respond(route);
    }
  );
  await page.route(thumbnailUrl, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#dce6df"/></svg>'
    })
  );
  await page.route(config.public.map.styleUrl, (route) =>
    route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: tileFailure
        ? {
            version: 8,
            sources: {
              offline: {
                type: 'raster',
                tiles: ['https://search-smoke.invalid/{z}/{x}/{y}.png'],
                tileSize: 256
              }
            },
            layers: [{ id: 'offline', type: 'raster', source: 'offline' }]
          }
        : {
            version: 8,
            sources: {},
            layers: [
              { id: 'background', type: 'background', paint: { 'background-color': '#e1ebe5' } }
            ]
          }
    })
  );
  await page.route('https://search-smoke.invalid/**', (route) => route.abort());
  await page.goto(initialUrl);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `Find a place in ${config.public.city}`
  );
  await assertCards(page);
  await expect
    .poll(() => requests.filter(({ path }) => path.endsWith('/markers')).length)
    .toBeGreaterThan(0);
  await expect(page.getByText(/zoom in/i).first()).toBeVisible();
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /498 approximate property locations/ })
  ).toBeVisible();
  const firstPrice = page.getByRole('button', { name: /€751 per month\. Approximate location\./ });
  await expect(firstPrice).toBeVisible();
  await firstPrice.click();
  await expect(firstPrice).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: `Show ${firstCards[0].title} on map`, exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('button', { name: `Show ${firstCards[1].title} on map`, exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: /€752 per month\. Approximate location\. Selected property\./
    })
  ).toHaveAttribute('aria-pressed', 'true');
  const markerRequests = requests.filter(({ path }) => path.endsWith('/markers')).length;
  await page.getByRole('button', { name: 'Load more homes', exact: true }).click();
  await assertCards(page, 3);
  await expect(page.getByRole('heading', { name: laterCard.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more homes', exact: true })).toHaveCount(0);
  assert.equal(
    requests.filter(({ path }) => path.endsWith('/markers')).length,
    markerRequests,
    'card paging must not request markers again'
  );
  assert.ok(requests.some(({ query }) => query.cursor === 'synthetic-next-page'));

  await page.getByLabel('Transaction', { exact: true }).selectOption('rent');
  await page.getByLabel('Property type', { exact: true }).selectOption('apartment');
  await page.getByLabel('Minimum price (€)', { exact: true }).fill('500');
  await page.getByLabel('Minimum bedrooms', { exact: true }).fill('2');
  await page.getByLabel('Minimum area (m²)', { exact: true }).fill('60');
  await apply(page, '1000');
  await assertCards(page);
  await expect
    .poll(() => requests.filter(({ query }) => query.maxPrice === '100000').length)
    .toBe(2);
  for (const { query } of requests.filter(({ query }) => query.maxPrice === '100000')) {
    assert.equal(query.transactionType, 'rent');
    assert.equal(query.propertyType, 'apartment');
    assert.equal(query.minPrice, '50000');
    assert.equal(query.minBedrooms, '2');
    assert.equal(query.minAreaM2, '60');
    assert.equal(query.cursor, undefined);
  }
  await apply(page, '1200');
  await assertCards(page);
  await page.goBack();
  await expect(page.getByLabel('Maximum price (€)', { exact: true })).toHaveValue('1000');
  await page.goForward();
  await expect(page.getByLabel('Maximum price (€)', { exact: true })).toHaveValue('1200');

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    if (width === 375) await page.getByRole('button', { name: 'Show list', exact: true }).click();
    await assertCards(page);
    await checkLayout(page, width);
    if (width === 375) {
      const urlBefore = page.url();
      const cardSelection = page.getByRole('button', {
        name: `Show ${firstCards[0].title} on map`,
        exact: true
      });
      await cardSelection.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Show map', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Show list', exact: true }).click();
      await page.getByRole('button', { name: 'Show map', exact: true }).click();
      await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
      await checkLayout(page, width, 'map');
      await page.getByRole('button', { name: 'Show list', exact: true }).click();
      await assertCards(page);
      assert.equal(page.url(), urlBefore, 'mobile switching preserves URL state');
      await expect(page.getByLabel('Maximum price (€)', { exact: true })).toHaveValue('1200');
    }
  }

  scenario = 'empty';
  await apply(page, '1300');
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByText(/no homes/i).first()).toBeVisible();
  scenario = 'error';
  await apply(page, '1400');
  await expect(page.getByRole('alert').first()).toBeVisible();
  scenario = 'normal';
  await page
    .getByRole('button', { name: /retry|try again/i })
    .first()
    .click();
  await assertCards(page);

  scenario = 'markers-error';
  await apply(page, '1450');
  await assertCards(page);
  await expect(page.getByRole('alert')).toContainText('Map prices could not be loaded');
  scenario = 'normal';
  await page.getByRole('button', { name: 'Retry search', exact: true }).click();
  await assertCards(page);

  scenario = 'pending';
  const failures = [];
  page.on('requestfailed', (request) => {
    if (request.url().includes('/listings/')) failures.push(request.url());
  });
  await apply(page, '1500');
  await expect.poll(() => pending.length).toBe(2);
  await page.getByText('Search area · keyboard controls', { exact: true }).click();
  await page.getByLabel('West', { exact: true }).fill(String(bounds.west + 0.01));
  await page.getByRole('button', { name: 'Update search area', exact: true }).click();
  await expect.poll(() => pending.length).toBe(4);
  await apply(page, '1600');
  await expect.poll(() => pending.length).toBe(6);
  await expect.poll(() => failures.length).toBeGreaterThanOrEqual(4);
  scenario = 'normal';
  await Promise.all(pending.slice(4).map((route) => respond(route)));
  await assertCards(page);
  await Promise.all(
    pending.slice(0, 4).map((route) => respond(route, 'empty').catch(() => undefined))
  );
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.getByLabel('Maximum price (€)', { exact: true })).toHaveValue('1600');
  await expect(
    page.getByRole('button', { name: /approximate property locations\. Zoom in/ }).first()
  ).toBeVisible();

  const beforePan = requests.length;
  const previousUrl = page.url();
  const canvas = page.locator('canvas.maplibregl-canvas');
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).not.toHaveURL(previousUrl);
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(beforePan + 2);
  await assertCards(page);
  await expect(
    page.getByRole('button', { name: /approximate property locations\. Zoom in/ }).first()
  ).toBeVisible();
  const beforeCluster = page.url();
  await page
    .getByRole('button', { name: /approximate property locations\. Zoom in/ })
    .first()
    .click();
  await expect(page).not.toHaveURL(beforeCluster);
  await assertCards(page);

  tileFailure = true;
  await page.goto(initialUrl);
  await assertCards(page);
  await expect(
    page.getByText(
      'The map could not load. You can still browse and filter the property results.',
      { exact: true }
    )
  ).toBeVisible();
  await apply(page, '1700');
  await assertCards(page);
  await page.getByRole('button', { name: 'Load more homes', exact: true }).click();
  await assertCards(page, 3);
  tileFailure = false;
  await page.getByRole('button', { name: 'Retry map', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /approximate property locations\. Zoom in/ }).first()
  ).toBeVisible();
  await assertCards(page, 3);
  assert.deepEqual(errors, [], 'search must not raise hydration or browser runtime errors');
  await writeFile(resolve(directory, 'requests.json'), JSON.stringify(requests, null, 2));
  console.log(
    'PASS: public search filters, URL/history, bounded independent paging, real MapLibre clusters/selection/panning, tile failure/list survival/retry, mobile state, empty/error retry, cancellation, stale-response suppression, responsive axe and overflow.'
  );
} catch (error) {
  await writeFile(
    resolve(directory, 'failure.json'),
    JSON.stringify({ message: error.message, errors, requests }, null, 2)
  );
  await page
    ?.screenshot({ path: resolve(directory, 'failure.png'), fullPage: true })
    .catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  stopChild(server);
}
