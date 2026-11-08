import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';
import { serverConfig } from './generated/server-config';
import { publicConfig } from './generated/public-config';
import type { ListingSitemapResponse } from '@viedom/contracts';
import { generateSitemap } from './sitemap';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

app.get('/robots.txt', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res
    .type('text/plain')
    .send(
      `User-agent: *\nDisallow: /owner\nDisallow: /admin\nDisallow: /auth\nDisallow: /health\nSitemap: ${publicConfig.webOrigin}/sitemap.xml\n`
    );
});

app.get('/sitemap.xml', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const signal = AbortSignal.timeout(10000);
    const sitemap = await generateSitemap(publicConfig.webOrigin, async (cursor) => {
      const url = new URL(`${serverConfig.apiBaseUrl}/listings/sitemap`);
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('Sitemap unavailable.');
      return (await response.json()) as ListingSitemapResponse;
    });
    res.type('application/xml').send(sitemap);
  } catch {
    res.status(503).setHeader('Retry-After', '60');
    res.type('text/plain').send('Sitemap temporarily unavailable.');
  }
});

/**
 * Example Express Rest API endpoints can be defined here.
 * Uncomment and define endpoints as necessary.
 *
 * Example:
 * ```ts
 * app.get('/api/{*splat}', (req, res) => {
 *   // Handle API request
 * });
 * ```
 */

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false
  })
);

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (/^\/(owner|admin|auth)(\/|$)/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  next();
});

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || process.env['WEB_PORT'] || serverConfig.port;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
