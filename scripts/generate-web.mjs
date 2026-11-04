import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadConfig, root } from './config.mjs';

export async function generateWeb() {
  const config = loadConfig();
  const directory = resolve(root, 'apps/web/src/generated');
  await mkdir(directory, { recursive: true });
  // Only this object is serialized. No automatic PUBLIC_ prefix expansion.
  await writeFile(
    resolve(directory, 'public-config.ts'),
    `import type { PublicConfig } from '@viedom/contracts';\nexport const publicConfig = ${JSON.stringify(config.public, null, 2)} satisfies PublicConfig;\n`
  );
  await writeFile(
    resolve(directory, 'server-config.ts'),
    `export const serverConfig = ${JSON.stringify({ apiBaseUrl: config.ssrApiBaseUrl, port: config.ports.web })};\n`
  );
  const webRequire = createRequire(resolve(root, 'apps/web/package.json'));
  const postcss = webRequire('postcss');
  const tailwind = webRequire('@tailwindcss/postcss');
  const input =
    '@layer theme, base, components, utilities;\n@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);\n@source "../app";\n';
  const result = await postcss([tailwind({ base: resolve(root, 'apps/web') })]).process(input, {
    from: resolve(directory, 'input.css')
  });
  await writeFile(resolve(directory, 'utilities.css'), result.css);
}

if (
  process.argv[1] === new URL(import.meta.url).pathname ||
  process.argv[1]?.endsWith('generate-web.mjs')
) {
  try {
    await generateWeb();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
