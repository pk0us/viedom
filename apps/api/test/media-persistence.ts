import assert from 'node:assert/strict';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { loadConfig } from '../../../scripts/config.mjs';

const config = loadConfig();
if (config.mode === 'production' || new URL(config.storage.endpoint).hostname !== '127.0.0.1')
  throw new Error('Storage persistence probe requires local storage.');
const probe = process.env['SMOKE_PROBE_ID'];
if (!probe || !/^[a-f0-9-]{36}$/.test(probe))
  throw new Error('Storage persistence probe requires an explicit synthetic run ID.');
const client = new S3Client({
  endpoint: config.storage.endpoint,
  region: config.storage.region,
  forcePathStyle: config.storage.forcePathStyle,
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey
  },
  requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
  maxAttempts: 1,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
});
const target = { Bucket: config.storage.bucket, Key: `private/probes/${probe}` };
const marker = 'Synthetic private storage persistence probe.';
try {
  if (process.argv[2] === 'write') {
    await client.send(new PutObjectCommand({ ...target, Body: marker, ContentType: 'text/plain' }));
    console.log('PASS: private storage persistence probe written.');
  } else if (process.argv[2] === 'verify') {
    const response = await client.send(new GetObjectCommand(target));
    assert.equal(await response.Body?.transformToString(), marker);
    await client.send(new DeleteObjectCommand(target));
    console.log('PASS: stored object survived normal Compose down/up; synthetic probe removed.');
  } else throw new Error('Use write or verify.');
} catch {
  console.error(
    'Storage persistence probe failed. Check local storage readiness; details withheld.'
  );
  process.exitCode = 1;
} finally {
  client.destroy();
}
