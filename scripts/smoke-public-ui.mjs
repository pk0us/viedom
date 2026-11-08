import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
let inquiryScenario = 'normal';
let ownerSession = false;
const ownerToken = 'public-ui-smoke-owner';
const inquiries = [];
const inquiryRequests = [];
const apiRequests = [];
const errors = [];
let browser;
let web;
const api = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-CSRF-Bootstrap, X-CSRF-Token, X-Inquiry-Request'
  );
  response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  response.setHeader('Cache-Control', 'no-store');
  const url = new URL(request.url, config.public.apiBaseUrl);
  const path = url.pathname;
  apiRequests.push({
    path,
    method: request.method,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie
  });
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (/\/fixture-\d\.webp$/.test(path)) {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#dce6df"/></svg>'
    );
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  let body;
  if (path.endsWith(`/listings/${id}/inquiries`) && request.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const submission = JSON.parse(Buffer.concat(chunks).toString());
      inquiryRequests.push({
        body: submission,
        origin: request.headers.origin,
        header: request.headers['x-inquiry-request'],
        authorization: request.headers.authorization,
        cookie: request.headers.cookie
      });
      if (inquiryScenario === 'rate-limited') {
        response.statusCode = 429;
        response.setHeader('Retry-After', '1');
        body = {
          error: { code: 'RATE_LIMITED', message: 'Try again shortly.', requestId: 'inquiry-smoke' }
        };
      } else {
        const inquiry = {
          id: 'b'.repeat(24),
          listingId: id,
          listingTitle: listing.content.title,
          name: submission.name,
          email: submission.email,
          phone: submission.phone || null,
          message: submission.message,
          status: 'unread',
          createdAt: '2026-11-08T12:00:00.000Z'
        };
        inquiries.unshift(inquiry);
        response.statusCode = 201;
        body = { id: inquiry.id };
      }
    } catch (error) {
      errors.push(error.message);
      response.statusCode = 400;
    }
  } else if (path.endsWith('/auth/csrf')) body = { csrfToken: 'public-ui-smoke-csrf' };
  else if (path.endsWith('/auth/refresh')) {
    if (ownerSession)
      body = {
        accessToken: ownerToken,
        expiresIn: 900,
        csrfToken: 'public-ui-smoke-csrf',
        user: {
          id: 'd'.repeat(24),
          email: 'publisher@example.test',
          firstName: 'Publisher',
          lastName: 'Fixture',
          role: 'USER',
          emailVerified: true
        }
      };
    else response.statusCode = 401;
  } else if (path.endsWith('/me/inquiries') && request.method === 'GET') {
    if (request.headers.authorization !== `Bearer ${ownerToken}`) response.statusCode = 401;
    else if (inquiryScenario === 'inbox-offline') response.statusCode = 503;
    else {
      const offset = url.searchParams.get('cursor') === 'older-inquiry' ? 1 : 0;
      body = {
        items: inquiries.slice(offset, offset + 1),
        nextCursor: offset ? null : 'older-inquiry'
      };
    }
  } else if (/\/me\/inquiries\/[a-f0-9]{24}$/.test(path) && request.method === 'PATCH') {
    if (request.headers.authorization !== `Bearer ${ownerToken}`) response.statusCode = 401;
    else {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const update = JSON.parse(Buffer.concat(chunks).toString());
        const inquiry = inquiries.find((item) => path.endsWith(`/${item.id}`));
        if (inquiry && ['unread', 'read', 'archived'].includes(update.status)) {
          inquiry.status = update.status;
          body = inquiry;
        } else response.statusCode = 400;
      } catch (error) {
        errors.push(error.message);
        response.statusCode = 400;
      }
    }
  } else if (scenario === 'offline') response.statusCode = 503;
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
    const inquiryForm = page.locator('#inquiry');
    const name = inquiryForm.getByLabel('Your name (required)', { exact: true });
    const email = inquiryForm.getByLabel('Email (required)', { exact: true });
    const phone = inquiryForm.getByLabel('Phone (optional)', { exact: true });
    const message = inquiryForm.getByLabel('Message (required)', { exact: true });
    const send = inquiryForm.getByRole('button', { name: 'Send inquiry', exact: true });
    const authRequestsBeforeInquiry = apiRequests.filter((request) =>
      request.path.includes('/auth/')
    ).length;
    await send.click();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(message).toHaveAttribute('aria-invalid', 'true');
    assert.equal(inquiryRequests.length, 0);
    await name.fill('Guest <script>visitor</script>');
    await email.fill('invalid-email');
    await message.fill('I would like to arrange a viewing of this home.');
    await send.click();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    assert.equal(inquiryRequests.length, 0);
    await email.fill('guest@example.test');
    await phone.fill('+30 210 555 0100');
    inquiryScenario = 'rate-limited';
    await send.click();
    await expect(inquiryForm.getByRole('alert')).toBeVisible();
    await expect(name).toHaveValue('Guest <script>visitor</script>');
    await expect(email).toHaveValue('guest@example.test');
    await expect(phone).toHaveValue('+30 210 555 0100');
    await expect(message).toHaveValue('I would like to arrange a viewing of this home.');
    assert.equal(inquiryRequests.length, 1);
    for (const width of [375, 768, 1024, 1440]) await layout(page, 'inquiry-retry', width);
    inquiryScenario = 'normal';
    await send.click();
    await expect(inquiryForm.getByRole('status')).toContainText('Your inquiry was sent.');
    assert.equal(inquiryRequests.length, 2);
    assert.equal(
      apiRequests.filter((request) => request.path.includes('/auth/')).length,
      authRequestsBeforeInquiry
    );
    for (const request of inquiryRequests) {
      assert.equal(request.origin, origin);
      assert.equal(request.header, '1');
      assert.equal(request.authorization, undefined);
      assert.equal(request.cookie, undefined);
      assert.deepEqual(request.body, {
        name: 'Guest <script>visitor</script>',
        email: 'guest@example.test',
        phone: '+30 210 555 0100',
        message: 'I would like to arrange a viewing of this home.',
        website: ''
      });
    }
    await layout(page, 'inquiry-success', 375);
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
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.locator('script[data-public-listing]')).toHaveCount(0);
    await page.goto(`${origin}/owner/inquiries`);
    await expect(page).toHaveURL(/\/auth\/login\?returnUrl=%2Fowner%2Finquiries$/);
    ownerSession = true;
    inquiries.push({
      id: 'c'.repeat(24),
      listingId: id,
      listingTitle: 'Older home inquiry',
      name: 'Earlier visitor',
      email: 'earlier@example.test',
      phone: null,
      message: '<img src=x onerror="alert(1)"> Please share viewing times.',
      status: 'read',
      createdAt: '2026-11-07T12:00:00.000Z'
    });
    inquiryScenario = 'inbox-offline';
    await page.goto(`${origin}/owner/inquiries`);
    await expect(page.getByRole('heading', { name: 'Inquiries', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry inquiries', exact: true })).toBeVisible();
    inquiryScenario = 'normal';
    await page.getByRole('button', { name: 'Retry inquiries', exact: true }).click();
    const latestInquiry = page.locator(`[data-inquiry-id="${'b'.repeat(24)}"]`);
    await expect(latestInquiry.getByRole('heading', { name: listing.content.title })).toBeVisible();
    await expect(
      latestInquiry.getByText('Guest <script>visitor</script>', { exact: true })
    ).toBeVisible();
    await expect(latestInquiry.getByText('Unread', { exact: true })).toBeVisible();
    for (const width of [375, 768, 1024, 1440]) await layout(page, 'inbox', width);
    await latestInquiry.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await expect(latestInquiry.getByText('Read', { exact: true })).toBeVisible();
    await latestInquiry.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(latestInquiry.getByText('Archived', { exact: true })).toBeVisible();
    await latestInquiry.getByRole('button', { name: 'Mark as unread', exact: true }).click();
    await expect(latestInquiry.getByText('Unread', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Load more inquiries', exact: true }).click();
    const olderInquiry = page.locator(`[data-inquiry-id="${'c'.repeat(24)}"]`);
    await expect(olderInquiry.getByRole('heading', { name: 'Older home inquiry' })).toBeVisible();
    await expect(
      olderInquiry.getByText('<img src=x onerror="alert(1)"> Please share viewing times.', {
        exact: true
      })
    ).toBeVisible();
    await expect(olderInquiry.locator('img, script')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Load more inquiries', exact: true })
    ).toHaveCount(0);
    assert.equal(inquiries.length, 2);
    await layout(page, 'inbox-paginated', 375);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: browser navigation, gallery keyboard controls, guest inquiry validation and retry, guarded inbox pagination and status changes, responsive layouts and axe.'
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
