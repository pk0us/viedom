import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { root, envPath, validateConfig } from './config.mjs';

if (existsSync(envPath)) {
  console.log('Root .env already exists; all values preserved.');
} else {
  const template = readFileSync(resolve(root, '.env.example'), 'utf8');
  const values = parse(template);
  // Allow port overrides for a fresh setup; related URLs are derived together.
  for (const key of ['WEB_PORT', 'API_PORT', 'MONGO_PORT'])
    values[key] = process.env[key] ?? values[key];
  values.WEB_ORIGIN = `http://localhost:${values.WEB_PORT}`;
  values.PUBLIC_API_BASE_URL = `http://localhost:${values.API_PORT}/api`;
  values.SSR_API_BASE_URL = `http://127.0.0.1:${values.API_PORT}/api`;
  for (const key of ['MONGO_INITDB_ROOT_PASSWORD', 'MONGO_APP_PASSWORD', 'MONGO_TEST_PASSWORD'])
    values[key] = randomBytes(32).toString('base64url');
  for (const [key, user, password, db] of [
    ['MONGO_URI', 'MONGO_APP_USERNAME', 'MONGO_APP_PASSWORD', 'MONGO_DB_NAME'],
    ['MONGO_TEST_URI', 'MONGO_TEST_USERNAME', 'MONGO_TEST_PASSWORD', 'MONGO_TEST_DB_NAME']
  ])
    values[key] =
      `mongodb://${encodeURIComponent(values[user])}:${encodeURIComponent(values[password])}@127.0.0.1:${values.MONGO_PORT}/${values[db]}?authSource=${values[db]}&replicaSet=rs0&directConnection=true`;
  validateConfig(values);
  writeFileSync(
    envPath,
    template.replace(/^([A-Z_]+)=.*$/gm, (line, key) => `${key}=${values[key]}`),
    { flag: 'wx', mode: 0o600 }
  );
  console.log('Created ignored root .env with generated local-only credentials.');
}
