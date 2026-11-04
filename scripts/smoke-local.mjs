import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadConfig, root } from './config.mjs';
import { run, cliPath, stopChild } from './process.mjs';
import { generateWeb } from './generate-web.mjs';

const config = loadConfig();
process.env.LEAK_SENTINEL ??= 'SYNTHETIC_PHASE02_SERVER_SECRET_MUST_STAY_PRIVATE';
if (config.mode === 'production') throw new Error('Local smoke refuses production.');
const children = [];
let browser;
const artifactDirectory = resolve(root, 'test-results/phase02');
await mkdir(artifactDirectory, { recursive: true });
const nodeScript = (file, args = [], options = {}) =>
  run(process.execPath, [resolve(root, file), ...args], options);
const apiDirectory = resolve(root, 'apps/api');
const webDirectory = resolve(root, 'apps/web');
const probeEnvironment = { ...process.env, SMOKE_PROBE_ID: randomUUID() };

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      /* startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local service did not become ready: ${new URL(url).pathname}`);
}

try {
  await nodeScript('scripts/infra.mjs', ['up']);
  await nodeScript('apps/api/test/database-smoke.ts', ['write'], { env: probeEnvironment });
  await nodeScript('scripts/infra.mjs', ['down']);
  await nodeScript('scripts/infra.mjs', ['up']);
  await nodeScript('apps/api/test/database-smoke.ts', ['verify'], { env: probeEnvironment });

  // Build using this invocation's configuration, including any port overrides.
  await run(process.execPath, [cliPath('typescript'), '-p', 'packages/contracts/tsconfig.json']);
  await run(process.execPath, [cliPath('@nestjs/cli', apiDirectory), 'build'], {
    cwd: apiDirectory
  });
  await generateWeb();
  await run(process.execPath, [cliPath('@angular/cli', webDirectory), 'build'], {
    cwd: webDirectory
  });
  children.push(spawn(process.execPath, ['dist/main.js'], { cwd: apiDirectory, stdio: 'inherit' }));
  await waitFor(`${config.public.apiBaseUrl}/health/ready`);
  const cors = await fetch(`${config.public.apiBaseUrl}/health`, {
    headers: { Origin: config.webOrigin }
  });
  assert.equal(cors.headers.get('access-control-allow-origin'), config.webOrigin);
  assert.deepEqual(await cors.json(), { status: 'ok', service: 'viedom-api' });
  children.push(
    spawn(process.execPath, ['dist/web/server/server.mjs'], {
      cwd: webDirectory,
      stdio: 'inherit',
      env: { ...process.env, PORT: String(config.ports.web) }
    })
  );
  await waitFor(config.webOrigin);
  const html = await (await fetch(config.webOrigin)).text();
  assert.ok(
    html.includes('Database connection is ready.'),
    'SSR must receive the typed API response'
  );
  await writeFile(resolve(artifactDirectory, 'health.html'), html);
  browser = await chromium.launch({
    channel:
      process.env.SMOKE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
    headless: true
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const liveResponse = page.waitForResponse(
    (response) => response.url() === `${config.public.apiBaseUrl}/health` && response.ok()
  );
  const readyResponse = page.waitForResponse(
    (response) => response.url() === `${config.public.apiBaseUrl}/health/ready` && response.ok()
  );
  await page.goto(config.webOrigin);
  await Promise.all([liveResponse, readyResponse]);
  await expect(page.getByText('Database connection is ready.', { exact: true })).toBeVisible();
  const styles = await page.locator('main').evaluate((element) => ({
    padding: getComputedStyle(element).padding,
    maxWidth: getComputedStyle(element).maxWidth
  }));
  assert.equal(styles.padding, '32px');
  assert.equal(styles.maxWidth, '672px');
  // Retry against an actual network outage, then recover without a reload.
  await page.route(`${config.public.apiBaseUrl}/health*`, (route) => route.abort());
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(
    page.getByText('API is unavailable. Start the API, then retry.', { exact: true })
  ).toBeVisible();
  await page.unroute(`${config.public.apiBaseUrl}/health*`);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByText('Database connection is ready.', { exact: true })).toBeVisible();
  assert.deepEqual(errors, [], 'hydration and browser runtime must have no errors');
  const accessibility = await new AxeBuilder({ page }).analyze();
  await writeFile(
    resolve(artifactDirectory, 'accessibility.json'),
    JSON.stringify(accessibility.violations, null, 2)
  );
  assert.deepEqual(
    accessibility.violations.map(({ id }) => id),
    [],
    'health page must pass axe'
  );
  await page.screenshot({ path: resolve(artifactDirectory, 'health.png'), fullPage: true });
  // Leak scan checks both the built assets and HTML under a synthetic secret.
  await nodeScript('scripts/check-leaks.mjs');
  const generated = await readFile(
    resolve(root, 'apps/web/src/generated/public-config.ts'),
    'utf8'
  );
  assert.ok(!generated.includes('MONGO_'));
  console.log(
    'PASS: SSR, browser-to-API, CORS, hydration, axe, independent Tailwind utilities and failure/retry.'
  );
} finally {
  await browser?.close();
  children.forEach(stopChild);
}
