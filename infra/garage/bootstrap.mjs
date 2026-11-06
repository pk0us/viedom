import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';

function saveCredentials(file, accessKeyId, secretAccessKey) {
  const original = readFileSync(file, 'utf8');
  const values = parse(original);
  if (values.S3_ACCESS_KEY_ID || values.S3_SECRET_ACCESS_KEY)
    throw new Error(
      'Storage credentials changed during initialization; existing values were preserved.'
    );
  for (const key of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
    if (!new RegExp(`^${key}=`, 'm').test(original))
      throw new Error('Run setup:local before initializing storage credentials.');
  }
  const updated = original
    .replace(/^S3_ACCESS_KEY_ID=.*$/gm, `S3_ACCESS_KEY_ID=${accessKeyId}`)
    .replace(/^S3_SECRET_ACCESS_KEY=.*$/gm, `S3_SECRET_ACCESS_KEY=${secretAccessKey}`);
  const temporary = `${file}.garage-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, updated, { flag: 'wx', mode: 0o600 });
    if (readFileSync(file, 'utf8') !== original)
      throw new Error(
        'Root environment changed during initialization; existing values were preserved.'
      );
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function initializeGarage(config, environment, file) {
  if (config.mode === 'production' || new URL(config.storage.endpoint).hostname !== '127.0.0.1')
    throw new Error('Garage bootstrap only operates on local development storage.');
  if (config.storage.region !== 'garage')
    throw new Error('Local Garage requires S3_REGION=garage.');
  const admin = `http://127.0.0.1:${config.ports.garageAdmin}`;
  const call = async (name, body, query) => {
    const url = new URL(`/v2/${name}`, admin);
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${environment.GARAGE_ADMIN_TOKEN}`,
        'content-type': 'application/json'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Local Garage ${name} failed (${response.status}).`);
    return response.json();
  };
  const waitFor = async (work, label) => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        return await work();
      } catch {
        await delay(1000);
      }
    }
    throw new Error(`Local Garage ${label} was not ready within 90 seconds.`);
  };
  const status = await waitFor(() => call('GetClusterStatus'), 'administration API');
  if (status.nodes.length !== 1 || !status.nodes[0].isUp)
    throw new Error('Local bootstrap requires exactly one connected Garage node.');
  const node = status.nodes[0];
  const layout = await call('GetClusterLayout');
  if (layout.version === 0 && layout.roles.length === 0) {
    const role = { id: node.id, zone: 'local', capacity: 1_000_000_000, tags: ['viedom-local'] };
    if (
      layout.stagedParameters ||
      layout.stagedRoleChanges.some(
        (change) =>
          change.id !== role.id ||
          change.zone !== role.zone ||
          change.capacity !== role.capacity ||
          JSON.stringify(change.tags) !== JSON.stringify(role.tags)
      )
    )
      throw new Error('Garage has unrelated staged layout changes; automatic bootstrap refused.');
    await call('UpdateClusterLayout', { roles: [role] });
    await call('ApplyClusterLayout', { version: 1 });
  } else if (
    layout.roles.length !== 1 ||
    layout.roles[0].id !== node.id ||
    layout.stagedRoleChanges.length ||
    layout.stagedParameters
  ) {
    throw new Error(
      'Existing Garage layout is not the expected local single-node layout; it was preserved.'
    );
  }
  await waitFor(async () => {
    const health = await fetch(`${admin}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error('Storage quorum unavailable.');
  }, 'storage quorum');

  let accessKeyId = config.storage.accessKeyId;
  let secretAccessKey = config.storage.secretAccessKey;
  if (!accessKeyId && !secretAccessKey) {
    const keyName = `viedom-local-media:${config.storage.bucket}`;
    const keys = (await call('ListKeys')).filter((key) => key.name === keyName);
    if (keys.length > 1)
      throw new Error('Multiple local media keys exist; automatic selection refused.');
    const key = keys.length
      ? await call('GetKeyInfo', undefined, { id: keys[0].id, showSecretKey: 'true' })
      : await call('CreateKey', { name: keyName, neverExpires: true });
    accessKeyId = key.accessKeyId;
    secretAccessKey = key.secretAccessKey;
    if (
      !/^GK[a-f0-9]{24}$/.test(accessKeyId) ||
      !/^[a-f0-9]{64}$/.test(secretAccessKey) ||
      key.expired
    )
      throw new Error('Garage returned unusable local credentials.');
    saveCredentials(file, accessKeyId, secretAccessKey);
    if (!process.env.S3_ACCESS_KEY_ID && !process.env.S3_SECRET_ACCESS_KEY) {
      process.env.S3_ACCESS_KEY_ID = accessKeyId;
      process.env.S3_SECRET_ACCESS_KEY = secretAccessKey;
    }
  } else {
    const key = await call('GetKeyInfo', undefined, { id: accessKeyId, showSecretKey: 'true' });
    if (key.expired || key.secretAccessKey !== secretAccessKey)
      throw new Error('Existing storage credentials do not match Garage; values were preserved.');
  }

  const buckets = await call('ListBuckets');
  let bucket = buckets.find((item) => item.globalAliases.includes(config.storage.bucket));
  if (!bucket) bucket = await call('CreateBucket', { globalAlias: config.storage.bucket });
  const permissions = {
    bucketId: bucket.id,
    accessKeyId,
    permissions: { read: true, write: true }
  };
  await call('AllowBucketKey', permissions);
  await call('DenyBucketKey', { bucketId: bucket.id, accessKeyId, permissions: { owner: true } });
  await call(
    'UpdateBucket',
    {
      websiteAccess: { enabled: false },
      corsRules: [
        {
          AllowedOrigin: [config.webOrigin],
          AllowedMethod: ['PUT'],
          AllowedHeader: ['content-type'],
          ExposeHeader: ['etag']
        }
      ]
    },
    { id: bucket.id }
  );
  const checked = await call('GetBucketInfo', undefined, { id: bucket.id });
  if (
    checked.websiteAccess ||
    !checked.keys.some(
      (key) =>
        key.accessKeyId === accessKeyId &&
        key.permissions.read &&
        key.permissions.write &&
        !key.permissions.owner
    )
  )
    throw new Error('Garage private bucket or application permissions failed validation.');
  console.log('Local Garage layout, private bucket, application key and browser CORS are ready.');
}
