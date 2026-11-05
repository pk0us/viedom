import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const envPath = resolve(root, '.env');

export function readEnvironment(env = process.env, file = envPath) {
  return { ...(existsSync(file) ? parse(readFileSync(file)) : {}), ...env };
}

function invalid(key, instruction) {
  throw new Error(`Invalid ${key}: ${instruction}. Check root .env or injected environment.`);
}

export function validateConfig(env) {
  const required = (key) => {
    const value = env[key];
    if (!value || value.includes('${')) invalid(key, 'supply a literal nonempty value');
    return value;
  };
  const mode = required('NODE_ENV');
  if (!['development', 'test', 'production'].includes(mode))
    invalid('NODE_ENV', 'use development, test or production');
  const port = (key) => {
    const value = required(key);
    if (!/^\d+$/.test(value) || +value < 1 || +value > 65535)
      invalid(key, 'use an integer from 1 to 65535');
    return +value;
  };
  const ports = { web: port('WEB_PORT'), api: port('API_PORT'), mongo: port('MONGO_PORT') };
  if (new Set(Object.values(ports)).size !== 3)
    invalid('WEB_PORT/API_PORT/MONGO_PORT', 'choose distinct ports');
  const url = (key, originOnly = false) => {
    const value = required(key);
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      invalid(key, 'use an absolute HTTP(S) URL');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (originOnly && parsed.origin !== value)
    )
      invalid(key, 'use an HTTP(S) URL without credentials, query or fragment');
    if (mode === 'production' && parsed.protocol !== 'https:')
      invalid(key, 'production requires HTTPS');
    return parsed;
  };
  const webOrigin = url('WEB_ORIGIN', true);
  const browserApi = url('PUBLIC_API_BASE_URL');
  const ssrApi = url('SSR_API_BASE_URL');
  if (mode !== 'production') {
    for (const [key, value, expected] of [
      ['WEB_ORIGIN', webOrigin, ports.web],
      ['PUBLIC_API_BASE_URL', browserApi, ports.api],
      ['SSR_API_BASE_URL', ssrApi, ports.api]
    ]) {
      if (
        !['localhost', '127.0.0.1'].includes(value.hostname) ||
        +(value.port || (value.protocol === 'https:' ? 443 : 80)) !== expected
      )
        invalid(key, 'match the configured local service host/port');
    }
    if (webOrigin.hostname !== browserApi.hostname)
      invalid('PUBLIC_API_BASE_URL', 'use the same browser hostname as WEB_ORIGIN');
  }
  for (const [key, value] of [
    ['PUBLIC_API_BASE_URL', browserApi],
    ['SSR_API_BASE_URL', ssrApi]
  ]) {
    if (value.pathname !== '/api') invalid(key, 'use the /api base path without a trailing slash');
  }
  const database = (key) => {
    const value = required(key);
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) invalid(key, 'use letters, digits, underscore or hyphen');
    return value;
  };
  const dbName = database('MONGO_DB_NAME');
  const testDbName = database('MONGO_TEST_DB_NAME');
  if (dbName === testDbName) invalid('MONGO_TEST_DB_NAME', 'use a separate test database');
  const mongoUri = (key, db, userKey, passwordKey) => {
    const value = required(key);
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      invalid(key, 'supply a valid authenticated MongoDB URI');
    }
    const authority = value.slice(value.indexOf('://') + 3).split('/')[0];
    const credentials = authority?.slice(0, authority.lastIndexOf('@'));
    if (
      !credentials ||
      credentials.includes('@') ||
      credentials.split(':').length !== 2 ||
      /[\s?#]/.test(credentials)
    )
      invalid(key, 'percent-encode reserved characters in credentials');
    if (
      !['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) ||
      !parsed.username ||
      !parsed.password ||
      parsed.pathname.slice(1) !== db
    )
      invalid(key, 'supply credentials and the matching database');
    if (mode !== 'production') {
      if (
        parsed.hostname !== '127.0.0.1' ||
        +(parsed.port || 27017) !== ports.mongo ||
        parsed.searchParams.get('authSource') !== db ||
        parsed.searchParams.get('replicaSet') !== 'rs0' ||
        parsed.searchParams.get('directConnection') !== 'true'
      )
        invalid(
          key,
          'use 127.0.0.1, MONGO_PORT, the matching authSource, replicaSet=rs0 and directConnection=true'
        );
      try {
        if (
          decodeURIComponent(parsed.username) !== required(userKey) ||
          decodeURIComponent(parsed.password) !== required(passwordKey)
        )
          invalid(key, 'match its configured app/test credentials');
      } catch {
        invalid(key, 'use percent-encoded matching credentials');
      }
    } else if (
      ['localhost', '127.0.0.1', 'mongo'].includes(parsed.hostname) ||
      (parsed.protocol === 'mongodb:' && parsed.searchParams.get('tls') !== 'true')
    )
      invalid(key, 'production requires a remote TLS database');
    return value;
  };
  const uri = mongoUri('MONGO_URI', dbName, 'MONGO_APP_USERNAME', 'MONGO_APP_PASSWORD');
  const testUri = mongoUri(
    'MONGO_TEST_URI',
    testDbName,
    'MONGO_TEST_USERNAME',
    'MONGO_TEST_PASSWORD'
  );
  if (mode !== 'production') {
    for (const key of ['MONGO_INITDB_ROOT_USERNAME', 'MONGO_INITDB_ROOT_PASSWORD']) required(key);
    if (
      new Set([env.MONGO_INITDB_ROOT_USERNAME, env.MONGO_APP_USERNAME, env.MONGO_TEST_USERNAME])
        .size !== 3
    )
      invalid(
        'MONGO_APP_USERNAME/MONGO_TEST_USERNAME',
        'use identities distinct from each other and root'
      );
  }
  const number = (key, min, max) => {
    const value = Number(required(key));
    if (!Number.isFinite(value) || value < min || value > max)
      invalid(key, `use a number between ${min} and ${max}`);
    return value;
  };
  const locale = required('PUBLIC_LOCALE');
  try {
    new Intl.NumberFormat(locale);
  } catch {
    invalid('PUBLIC_LOCALE', 'use a supported locale');
  }
  if (required('PUBLIC_CURRENCY') !== 'EUR') invalid('PUBLIC_CURRENCY', 'use EUR for the MVP');
  const accessSecret = required('ACCESS_TOKEN_SECRET');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(accessSecret))
    invalid('ACCESS_TOKEN_SECRET', 'use 32 or more randomly generated base64url bytes');
  const accessTtl = number('ACCESS_TOKEN_TTL_SECONDS', 60, 900);
  const refreshTtl = number('REFRESH_TOKEN_TTL_SECONDS', 3600, 2592000);
  if (!Number.isInteger(accessTtl) || !Number.isInteger(refreshTtl))
    invalid('ACCESS_TOKEN_TTL_SECONDS/REFRESH_TOKEN_TTL_SECONDS', 'use integer seconds');
  const cookieName = required('REFRESH_COOKIE_NAME');
  if (!/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(cookieName))
    invalid('REFRESH_COOKIE_NAME', 'use a short alphanumeric name');
  if (!['true', 'false'].includes(required('COOKIE_SECURE')))
    invalid('COOKIE_SECURE', 'use true or false');
  const secure = env.COOKIE_SECURE === 'true';
  if (required('COOKIE_SAME_SITE') !== 'lax') invalid('COOKIE_SAME_SITE', 'use lax');
  if (mode === 'production' && (!secure || browserApi.origin !== webOrigin.origin))
    invalid(
      'COOKIE_SECURE/PUBLIC_API_BASE_URL',
      'production requires Secure cookies and same-origin /api routing'
    );
  const googleClientId = env.GOOGLE_CLIENT_ID || '';
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET || '';
  if (Boolean(googleClientId) !== Boolean(googleClientSecret))
    invalid('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET', 'supply both or leave both empty');
  if (
    googleClientId &&
    (!/^[A-Za-z0-9.-]+\.apps\.googleusercontent\.com$/.test(googleClientId) ||
      googleClientSecret.length < 10)
  )
    invalid('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET', 'supply valid Google web-client credentials');
  return {
    mode,
    ports,
    webOrigin: webOrigin.origin,
    ssrApiBaseUrl: ssrApi.href,
    mongo: { uri, testUri, dbName, testDbName },
    auth: {
      accessSecret,
      accessTtl,
      refreshTtl,
      cookieName,
      secure,
      googleClientId,
      googleClientSecret,
      googleCallbackUrl: `${browserApi.href}/auth/google/callback`
    },
    public: {
      apiBaseUrl: browserApi.href,
      locale,
      currency: 'EUR',
      city: required('PUBLIC_CITY'),
      map: {
        longitude: number('PUBLIC_MAP_LONGITUDE', -180, 180),
        latitude: number('PUBLIC_MAP_LATITUDE', -90, 90),
        zoom: number('PUBLIC_MAP_ZOOM', 0, 22)
      }
    }
  };
}

export function loadConfig() {
  return validateConfig(readEnvironment());
}
