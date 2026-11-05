import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { root, readEnvironment } from './config.mjs';

const env = readEnvironment();
const values = [
  'MONGO_INITDB_ROOT_PASSWORD',
  'MONGO_APP_PASSWORD',
  'MONGO_TEST_PASSWORD',
  'MONGO_URI',
  'MONGO_TEST_URI',
  'ACCESS_TOKEN_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'SMTP_PASSWORD',
  'LEAK_SENTINEL'
]
  .map((key) => env[key])
  .filter((value) => value && value.length > 7);
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else {
      const content = await readFile(path, 'utf8');
      if (
        values.some(
          (value) => content.includes(value) || content.includes(encodeURIComponent(value))
        )
      )
        throw new Error(
          'Secret boundary check failed; sensitive value found in generated web artifacts.'
        );
    }
  }
}
await scan(resolve(root, 'apps/web/dist/web'));
for (const page of ['home', 'health']) {
  const renderedHtml = resolve(root, `test-results/phase02/${page}.html`);
  if (existsSync(renderedHtml)) {
    const html = await readFile(renderedHtml, 'utf8');
    if (values.some((value) => html.includes(value)))
      throw new Error('Sensitive value found in rendered public HTML.');
  }
}
console.log(
  'PASS: generated browser/server web artifacts contain none of the configured secrets or sentinel values.'
);
