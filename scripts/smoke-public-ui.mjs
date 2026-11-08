import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadConfig, root } from './config.mjs';

const config = loadConfig();
if (config.mode === 'production') throw new Error('Public UI smoke refuses production.');
const origin = config.webOrigin;
const directory = resolve(root, 'test-results/public-ui');
const id = 'a'.repeat(24);
const image = (number) => ({
  url: `${config.public.apiBaseUrl}/fixture-${number}.webp`,
  width: 1200,
  height: 800,
  bytes: 100,
  contentType: 'image/webp'
});
const listing = {
  id,
  slug: 'sunny-city-home',
  publishedAt: '2026-11-01T12:00:00.000Z',
  locationPrecision: 'approximate',
  content: {
    title: 'Sunny city home',
    description:
      'A welcoming city home with a bright balcony. </script><script>alert("unsafe")</script>',
    transactionType: 'rent',
    priceMinor: 85025,
    currency: 'EUR',
    property: {
      type: 'apartment',
      details: {
        areaM2: 85,
        bedrooms: 2,
        bathrooms: 1,
        floor: 3,
        yearBuilt: 2005,
        amenities: ['Balcony', 'Elevator']
      },
      address: { countryCode: 'GR', city: config.public.city, neighborhood: 'City centre' },
      publicLocation: {
        type: 'Point',
        coordinates: [config.public.map.longitude, config.public.map.latitude]
      }
    },
    media: {
      coverMediaId: 'first',
      items: ['first', 'second'].map((value, index) => ({
        id: value,
        variants: { large: image(index), thumbnail: image(index) }
      }))
    }
  }
};
const card = {
  id,
  slug: listing.slug,
  title: listing.content.title,
  publishedAt: listing.publishedAt,
  transactionType: 'rent',
  priceMinor: 85025,
  currency: 'EUR',
  publicLocation: listing.content.property.publicLocation,
  locationPrecision: 'approximate',
  propertyType: 'apartment',
  areaM2: 85,
  bedrooms: 2,
  bathrooms: 1,
  city: config.public.city,
  neighborhood: 'City centre',
  coverImage: image(0)
};
const detailPath = `/listings/${id}/${listing.slug}`;
let scenario = 'normal';
const apiRequests = [];
const errors = [];
let browser;
let web;
const api = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Cache-Control', 'no-store');
  const path = new URL(request.url, config.public.apiBaseUrl).pathname;
  apiRequests.push({
    path,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie
  });
  if (/\/fixture-\d\.webp$/.test(path)) {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#dce6df"/></svg>'
    );
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  let body;
  if (scenario === 'offline') response.statusCode = 503;
  else if (path.endsWith('/listings/recent')) body = { items: scenario === 'empty' ? [] : [card] };
  else if (path.endsWith('/listings/sitemap'))
    body = {
      items:
        scenario === 'withdrawn'
          ? []
          : [{ id, slug: listing.slug, publishedAt: listing.publishedAt }],
      nextCursor: null
    };
  else if (path.endsWith(`/listings/${id}`) && scenario !== 'withdrawn') body = listing;
  else response.statusCode = 404;
  response.end(
    JSON.stringify(
      body ?? { error: { code: 'NOT_FOUND', message: 'Unavailable', requestId: 'public-ui-smoke' } }
    )
  );
});

async function html(path, status = 200, headers = {}) {
  const response = await fetch(`${origin}${path}`, {
    redirect: 'manual',
    headers,
    signal: AbortSignal.timeout(15000)
  });
  assert.equal(response.status, status, path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { response, text: await response.text() };
}

async function layout(page, name, width) {
  await page.setViewportSize({ width, height: 960 });
  assert.equal(
    await page.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    `${name} ${width}px overflow`
  );
  const result = await new AxeBuilder({ page }).analyze();
  await writeFile(
    resolve(directory, `${name}-${width}-axe.json`),
    JSON.stringify(result.violations, null, 2)
  );
  assert.deepEqual(
    result.violations.map((violation) => violation.id),
    [],
    `${name} ${width}px axe`
  );
  await page.screenshot({ path: resolve(directory, `${name}-${width}.png`), fullPage: true });
}

await mkdir(directory, { recursive: true });
try {
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(config.ports.api, '127.0.0.1', resolve);
  });
  web = spawn(process.execPath, ['dist/web/server/server.mjs'], {
    cwd: resolve(root, 'apps/web'),
    stdio: 'inherit',
    env: { ...process.env, PORT: String(config.ports.web) }
  });
  web.once('error', (error) => errors.push(error.message));
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          return false;
        }
      },
      { timeout: 20000 }
    )
    .toBe(true);
  const home = await html('/');
  assert.ok(home.text.includes(listing.content.title));
  assert.ok(home.text.includes(`href="${detailPath}"`));
  const detail = await html(detailPath);
  await html(detailPath, 200, {
    Cookie: 'viedom_refresh=synthetic-private-session',
    Authorization: 'Bearer synthetic-private-access'
  });
  await writeFile(resolve(directory, 'detail.html'), detail.text);
  assert.ok(detail.text.includes('<h1'));
  assert.ok(detail.text.includes('€850.25'));
  assert.ok(detail.text.includes(`href="${origin}${detailPath}"`));
  assert.ok(detail.text.includes('application/ld+json'));
  for (const forbidden of [
    'privateLocation',
    'streetAddress',
    'ownerId',
    'publisherId',
    'propertyId',
    'processingKeys',
    '<script>alert("unsafe")</script>'
  ])
    assert.ok(!detail.text.includes(forbidden), forbidden);
  const stale = await html(`/listings/${id}/old-slug`, 301);
  assert.equal(stale.response.headers.get('location'), detailPath);
  const noSlug = await html(`/listings/${id}`, 301);
  assert.equal(noSlug.response.headers.get('location'), detailPath);
  await html('/listings/not-an-id/missing', 404);
  let sitemap = await html('/sitemap.xml');
  assert.ok(sitemap.text.includes(`${origin}${detailPath}`));
  assert.ok(!sitemap.text.includes('/owner'));
  const robots = await html('/robots.txt');
  assert.ok(robots.text.includes(`Sitemap: ${origin}/sitemap.xml`));
  for (const path of ['/owner', '/admin/listings', '/auth/login']) {
    const privatePage = await html(path);
    assert.equal(privatePage.response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.ok(!privatePage.text.includes('data-public-listing'));
  }
  scenario = 'withdrawn';
  const withdrawn = await html(detailPath, 404);
  assert.ok(withdrawn.text.includes('noindex, nofollow'));
  assert.ok(!withdrawn.text.includes('application/ld+json'));
  sitemap = await html('/sitemap.xml');
  assert.ok(!sitemap.text.includes(detailPath));
  scenario = 'offline';
  const failedHome = await html('/');
  assert.ok(failedHome.text.includes('Recent homes unavailable'));
  assert.ok(!failedHome.text.includes('synthetic-private-session'));
  await html(detailPath, 503);
  await html('/sitemap.xml', 503);
  scenario = 'normal';
  assert.ok(apiRequests.every((request) => !request.authorization && !request.cookie));
  console.log(
    'PASS: production SSR, redirects, status codes, sitemap removal, metadata escaping and anonymous requests.'
  );
  if (!process.argv.includes('--ssr-only')) {
    browser = await chromium.launch({
      channel:
        process.env.SMOKE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
      headless: true
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await expect(
      page.getByRole('heading', { name: listing.content.title, exact: true })
    ).toBeVisible();
    for (const width of [375, 768, 1024, 1440]) await layout(page, 'home', width);
    await page.getByRole('link', { name: listing.content.title, exact: true }).click();
    await expect(page).toHaveURL(`${origin}${detailPath}`);
    await expect(
      page.getByRole('heading', { name: listing.content.title, level: 1 })
    ).toBeFocused();
    await expect(page.getByText('€850.25', { exact: false })).toBeVisible();
    const next = page.getByRole('button', { name: 'Next photo', exact: true });
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Photo 2 of 2', { exact: true })).toBeVisible();
    await expect(next).toBeFocused();
    for (const width of [375, 768, 1024, 1440]) await layout(page, 'detail', width);
    await page.getByRole('link', { name: 'Contact options', exact: true }).click();
    await expect(page.locator('#inquiry')).toBeFocused();
    scenario = 'withdrawn';
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Home unavailable', exact: true })
    ).toBeVisible();
    scenario = 'offline';
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Listing temporarily unavailable', exact: true })
    ).toBeVisible();
    scenario = 'normal';
    await page.getByRole('button', { name: 'Retry listing', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: listing.content.title, level: 1 })
    ).toBeVisible();
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.locator('script[data-public-listing]')).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: browser navigation, gallery keyboard controls, inquiry focus, retry, responsive layouts and axe.'
    );
  }
} finally {
  await browser?.close();
  if (web && web.exitCode === null && web.signalCode === null) {
    const stopped = new Promise((resolve) => web.once('exit', resolve));
    web.kill();
    await stopped;
  }
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
}
