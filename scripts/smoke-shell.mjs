import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { root } from './config.mjs';

// Called by smoke:local against the production build and real local services.
export async function checkShell(page, origin, apiBaseUrl) {
  const directory = resolve(root, 'test-results/phase03');
  await mkdir(directory, { recursive: true });
  const results = [];
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (const path of [
      '/',
      '/owner',
      '/health',
      '/missing-page',
      '/owner/missing-page',
      '/admin',
      '/admin/review'
    ]) {
      const response = await page.goto(`${origin}${path}`);
      if (/^\/(owner|admin)(\/|$)/.test(path)) {
        assert.equal(response.headers()['cache-control'], 'no-store');
        assert.equal(response.headers()['x-robots-tag'], 'noindex, nofollow');
      }
      await expect(page.locator('h1')).toBeVisible();
      if (path.startsWith('/owner')) {
        await expect(page).toHaveURL(`${origin}/auth/login?returnUrl=${encodeURIComponent(path)}`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back');
        await expect(page.getByRole('navigation', { name: 'Owner navigation' })).toHaveCount(0);
      }
      if (path === '/')
        await expect(page.getByRole('link', { name: 'Explore the owner workspace' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: /admin/i })).toHaveCount(0);
      assert.equal(
        await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
        `${width}px ${path} must not overflow`
      );
      const accessibility = await new AxeBuilder({ page }).analyze();
      results.push({ width, path, violations: accessibility.violations });
      assert.deepEqual(
        accessibility.violations.map(({ id }) => id),
        [],
        `${width}px ${path} axe`
      );
      if (path === '/' || path === '/owner') {
        await page.screenshot({
          path: resolve(directory, `${path === '/' ? 'public' : 'login'}-${width}.png`),
          fullPage: true
        });
      }
      if (path.startsWith('/admin') || path === '/missing-page')
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          "Let's find your way back."
        );
      if (path.startsWith('/owner'))
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
          'content',
          'noindex, nofollow'
        );
    }
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(origin);
  // Verify the complete mobile keyboard sequence, including disclosure and focus recovery.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.goto(origin);
  await page.keyboard.press('Tab'); // skip link
  await page.keyboard.press('Tab'); // brand
  await page.keyboard.press('Tab'); // disclosure
  const menu = page.getByRole('button', { name: 'Menu' });
  await expect(menu).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Owner workspace', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Welcome back', exact: true })
  ).toBeFocused();
  await page.getByRole('link', { name: 'Skip to content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page).toHaveURL(`${origin}/auth/login?returnUrl=%2Fowner`);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  // Desktop navigation and browser history keep focus and active state coherent.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('link', { name: 'Owner workspace', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back');
  await expect(page.getByRole('link', { name: 'Log in', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const healthResponse = page.waitForResponse(
    (response) => response.url() === `${apiBaseUrl}/health` && response.ok()
  );
  const readyResponse = page.waitForResponse(
    (response) => response.url() === `${apiBaseUrl}/health/ready` && response.ok()
  );
  await page.goto(`${origin}/health`);
  await Promise.all([healthResponse, readyResponse]);
  await expect(page.getByText('Database connection is ready.', { exact: true })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Check again' });
  await retry.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(retry).toBeFocused();
  const focusStyle = await retry.evaluate((element) => ({
    width: getComputedStyle(element).outlineWidth,
    style: getComputedStyle(element).outlineStyle
  }));
  assert.deepEqual(
    focusStyle,
    { width: '3px', style: 'solid' },
    'NG-ZORRO keyboard focus must keep the visible application outline'
  );
  const pending = [];
  await page.route(`${apiBaseUrl}/health**`, (route) => {
    pending.push(route);
  });
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => pending.length).toBe(2);
  await expect(page.getByRole('status')).toHaveCount(2);
  await expect(retry).toBeDisabled();
  const animations = await page
    .locator('nz-spin')
    .first()
    .evaluate((element) =>
      [element, ...element.querySelectorAll('*')].map(
        (node) => getComputedStyle(node).animationName
      )
    );
  assert.ok(
    animations.every((name) => name === 'none'),
    'reduced motion must suppress spinner animation'
  );
  await Promise.all(pending.map((route) => route.continue()));
  await page.unroute(`${apiBaseUrl}/health**`);
  await expect(page.getByText('Database connection is ready.', { exact: true })).toBeVisible();
  await writeFile(resolve(directory, 'accessibility.json'), JSON.stringify(results, null, 2));
  console.log(
    'PASS: shell routes, reserved admin boundary, 375/768/1024/1440px, keyboard navigation, focus, history and axe.'
  );
}
