import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { validateConfig, readEnvironment } from './config.mjs';

const valid = {
  NODE_ENV: 'development',
  ACCESS_TOKEN_SECRET: 'A'.repeat(43),
  ACCESS_TOKEN_TTL_SECONDS: '600',
  REFRESH_TOKEN_TTL_SECONDS: '604800',
  REFRESH_COOKIE_NAME: 'viedom_refresh',
  COOKIE_SECURE: 'false',
  COOKIE_SAME_SITE: 'lax',
  WEB_PORT: '4200',
  API_PORT: '3000',
  MONGO_PORT: '27017',
  WEB_ORIGIN: 'http://localhost:4200',
  PUBLIC_API_BASE_URL: 'http://localhost:3000/api',
  SSR_API_BASE_URL: 'http://127.0.0.1:3000/api',
  MONGO_DB_NAME: 'dev',
  MONGO_TEST_DB_NAME: 'test',
  MONGO_APP_USERNAME: 'app',
  MONGO_APP_PASSWORD: 'p@ss',
  MONGO_TEST_USERNAME: 'test',
  MONGO_TEST_PASSWORD: 'testpass',
  MONGO_INITDB_ROOT_USERNAME: 'root',
  MONGO_INITDB_ROOT_PASSWORD: 'rootpass',
  MONGO_URI:
    'mongodb://app:p%40ss@127.0.0.1:27017/dev?authSource=dev&replicaSet=rs0&directConnection=true',
  MONGO_TEST_URI:
    'mongodb://test:testpass@127.0.0.1:27017/test?authSource=test&replicaSet=rs0&directConnection=true',
  PUBLIC_LOCALE: 'en-GB',
  PUBLIC_CURRENCY: 'EUR',
  PUBLIC_CITY: 'Thessaloniki',
  PUBLIC_MAP_LONGITUDE: '22.9444',
  PUBLIC_MAP_LATITUDE: '40.6401',
  PUBLIC_MAP_ZOOM: '12'
};
test('public config is an explicit allowlist including no arbitrary PUBLIC_ keys', () => {
  const result = validateConfig({ ...valid, PUBLIC_SECRET: 'SYNTHETIC_SECRET' });
  assert.deepEqual(Object.keys(result.public).sort(), [
    'apiBaseUrl',
    'city',
    'currency',
    'locale',
    'map'
  ]);
  assert.ok(!JSON.stringify(result.public).includes('SYNTHETIC_SECRET'));
});
for (const [key, value] of [
  ['API_PORT', '4200'],
  ['WEB_PORT', '0'],
  ['MONGO_PORT', '12.5'],
  ['NODE_ENV', 'unknown'],
  ['MONGO_TEST_DB_NAME', 'dev'],
  ['MONGO_URI', 'SYNTHETIC_SECRET'],
  ['MONGO_APP_PASSWORD', ''],
  ['PUBLIC_API_BASE_URL', 'http://127.0.0.1:3000/api'],
  ['WEB_ORIGIN', 'http://localhost:4201'],
  ['PUBLIC_MAP_LATITUDE', 'NaN'],
  ['PUBLIC_CURRENCY', 'USD'],
  ['ACCESS_TOKEN_SECRET', 'SYNTHETIC_SECRET'],
  ['ACCESS_TOKEN_TTL_SECONDS', '900.5'],
  ['COOKIE_SECURE', 'yes'],
  ['COOKIE_SAME_SITE', 'none'],
  ['REFRESH_COOKIE_NAME', 'bad;cookie'],
  ['GOOGLE_CLIENT_ID', 'missing-secret.apps.googleusercontent.com']
])
  test(`rejects invalid ${key} without echoing its value`, () => {
    assert.throws(
      () => validateConfig({ ...valid, [key]: value }),
      (error) => /Invalid /.test(error.message) && !error.message.includes('SYNTHETIC_SECRET')
    );
  });
test('missing configuration identifies the variable', () =>
  assert.throws(() => validateConfig({}), /NODE_ENV/));
test('deployment rejects insecure origins', () =>
  assert.throws(() => validateConfig({ ...valid, NODE_ENV: 'production' }), /HTTPS/));
test('process environment wins over a file without interpolation', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'viedom-config-'));
  try {
    const file = resolve(directory, '.env');
    writeFileSync(file, 'API_PORT=3000\nLITERAL=${API_PORT}\n');
    const environment = readEnvironment({ API_PORT: '3010' }, file);
    assert.equal(environment.API_PORT, '3010');
    assert.equal(environment.LITERAL, '${API_PORT}');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('requires encoded Mongo credentials', () => {
  assert.throws(
    () => validateConfig({ ...valid, MONGO_URI: valid.MONGO_URI.replace('p%40ss', 'p@ss') }),
    /MONGO_URI/
  );
});

test('production enforces Secure cookies and same-origin browser API, with fixed callback URL', () => {
  const deployed = {
    ...valid,
    NODE_ENV: 'production',
    WEB_ORIGIN: 'https://viedom.example',
    PUBLIC_API_BASE_URL: 'https://viedom.example/api',
    SSR_API_BASE_URL: 'https://api.internal.example/api',
    MONGO_URI: 'mongodb://app:secret@db.example/dev?tls=true',
    MONGO_TEST_URI: 'mongodb://test:secret@db.example/test?tls=true',
    COOKIE_SECURE: 'true'
  };
  assert.equal(validateConfig(deployed).auth.secure, true);
  assert.equal(
    validateConfig(deployed).auth.googleCallbackUrl,
    'https://viedom.example/api/auth/google/callback'
  );
  assert.throws(() => validateConfig({ ...deployed, COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
  assert.throws(
    () => validateConfig({ ...deployed, PUBLIC_API_BASE_URL: 'https://other.example/api' }),
    /PUBLIC_API_BASE_URL/
  );
  assert.equal(
    validateConfig({
      ...valid,
      GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'synthetic-client-secret'
    }).auth.googleClientId,
    'synthetic.apps.googleusercontent.com'
  );
});
