import type { ListingSitemapResponse } from '@viedom/contracts';

function xml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (character) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;'
      })[character]!
  );
}

export async function generateSitemap(
  origin: string,
  readPage: (cursor: string | null) => Promise<ListingSitemapResponse>
): Promise<string> {
  const entries = [`<url><loc>${xml(new URL('/', origin).href)}</loc></url>`];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const result = await readPage(cursor);
    for (const item of result.items) {
      if (entries.length >= 50000) throw new Error('Sitemap size limit exceeded.');
      const path = `/listings/${encodeURIComponent(item.id)}/${encodeURIComponent(item.slug)}`;
      entries.push(`<url><loc>${xml(new URL(path, origin).href)}</loc></url>`);
    }
    if (!result.nextCursor)
      return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>`;
    if (cursors.has(result.nextCursor)) throw new Error('Invalid sitemap continuation.');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('Sitemap page limit exceeded.');
}
