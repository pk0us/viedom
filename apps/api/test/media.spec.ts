import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import sharp from 'sharp';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  MediaUploadResponse,
  OwnerListingDetail,
  OwnerMediaGallery,
  OwnerProperty,
  UploadContentType
} from '@viedom/contracts';
import { loadConfig } from '../../../scripts/config.mjs';
import { Configuration } from '../src/configuration.js';
import { ApiErrorFilter } from '../src/api-error.filter.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthMail } from '../src/auth/auth.mail.js';
import { AuthActions } from '../src/auth/auth.actions.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthStore } from '../src/auth/auth.store.js';
import { localTarget } from '../src/database/local-target.js';
import { initializeOrm, ormOptions } from '../src/database/orm-options.js';
import { provision } from '../src/database/provision.js';
import { Listing, User } from '../src/database/entities.js';
import { PropertiesModule } from '../src/properties/properties.module.js';
import { ListingsModule } from '../src/listings/listings.module.js';
import { MediaModule } from '../src/media/media.module.js';
import { MediaAsset } from '../src/media/media.entities.js';
import { ImageProcessor, MAX_IMAGE_BYTES } from '../src/media/image-processor.js';
import { MediaWorker } from '../src/media/media.worker.js';
import { MediaStorage } from '../src/media/storage.js';

const config = loadConfig();
const run = new ObjectId().toHexString();
const accounts: User[] = [];
let orm: MikroORM;
let app: INestApplication;
let base: string;
let store: AuthStore;
let worker: MediaWorker;
let storage: MediaStorage;
let owner: Client;
let other: Client;
let admin: Client;
let image: Buffer;

class Client {
  constructor(
    readonly id: ObjectId,
    readonly token: string
  ) {}

  request(path: string, method = 'GET', body?: unknown) {
    return fetch(`${base}/api/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
}

async function account(role: 'USER' | 'ADMIN' = 'USER') {
  const user = Object.assign(new User(), {
    email: `${run}.${accounts.length}@example.invalid`,
    firstName: 'Synthetic',
    lastName: 'Photographer',
    emailVerifiedAt: new Date(),
    role
  });
  accounts.push(user);
  const em = orm.em.fork();
  em.persist(user);
  await em.flush();
  const session = await store.create({ user }, config.auth.refreshTtl);
  const response = await app.get(AuthService).response(session);
  return new Client(user._id, response.accessToken);
}

async function listing(client = owner): Promise<OwnerListingDetail> {
  const property = await client.request('properties', 'POST', {
    type: 'apartment',
    details: {
      areaM2: 75,
      bedrooms: 2,
      bathrooms: 1,
      floor: 0,
      yearBuilt: null,
      amenities: []
    },
    address: { countryCode: 'GR', city: 'Thessaloniki', neighborhood: '', street: '' },
    privateLocation: { type: 'Point', coordinates: [22.9444, 40.6401] }
  });
  expect(property.status).toBe(201);
  const canonical: OwnerProperty = await property.json();
  const response = await client.request('listings', 'POST', {
    transactionType: 'rent',
    title: 'Synthetic media integration home',
    description: 'Synthetic listing for local object storage verification only.',
    priceMinor: 75000,
    currency: 'EUR',
    propertyId: canonical.id,
    expectedPropertyVersion: canonical.version
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function gallery(id: string, client = owner): Promise<OwnerMediaGallery> {
  const response = await client.request(`listings/${id}/media`);
  expect(response.status).toBe(200);
  return response.json();
}

async function authorize(
  id: string,
  bytes = image.length,
  contentType: UploadContentType = 'image/jpeg',
  client = owner
): Promise<MediaUploadResponse> {
  const current = await gallery(id, client);
  const response = await client.request(`listings/${id}/media/upload-url`, 'POST', {
    expectedVersion: current.version,
    bytes,
    contentType
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function put(authorization: MediaUploadResponse, bytes = image) {
  const response = await fetch(authorization.uploadUrl, {
    method: 'PUT',
    headers: authorization.headers,
    body: new Uint8Array(bytes)
  });
  expect(response.ok).toBe(true);
}

async function complete(id: string, mediaId: string, expectedVersion?: number) {
  return owner.request(`listings/${id}/media/complete`, 'POST', {
    mediaId,
    expectedVersion: expectedVersion ?? (await gallery(id)).version
  });
}

async function upload(id: string, bytes = image, contentType: UploadContentType = 'image/jpeg') {
  const authorization = await authorize(id, bytes.length, contentType);
  await put(authorization, bytes);
  const response = await complete(id, authorization.mediaId);
  expect(response.status).toBe(200);
  return authorization;
}

async function asset(id: string) {
  return orm.em.fork().findOneOrFail(MediaAsset, new ObjectId(id));
}

async function published(id: string) {
  const current = await gallery(id);
  await orm.em.fork().nativeUpdate(Listing, new ObjectId(id), {
    status: 'published',
    submittedVersion: current.version,
    approvedVersion: current.version,
    reviewedById: admin.id,
    publishedAt: new Date(Date.now() - 1000)
  });
}

beforeAll(async () => {
  const target = localTarget(config, true);
  orm = await initializeOrm(ormOptions(target.uri, target.dbName));
  await provision(orm);
  const testing = await Test.createTestingModule({
    imports: [AuthModule, PropertiesModule, ListingsModule, MediaModule]
  })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .overrideProvider(CoreMikroORM)
    .useValue(orm)
    .overrideProvider(Configuration)
    .useValue({ values: config })
    .overrideProvider(AuthMail)
    .useValue({ send: vi.fn() })
    .compile();
  app = testing.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );
  app.useGlobalFilters(new ApiErrorFilter());
  await app.listen(0, '127.0.0.1');
  await app.get(AuthActions).onModuleDestroy();
  base = await app.getUrl();
  store = app.get(AuthStore);
  worker = app.get(MediaWorker);
  storage = app.get(MediaStorage);
  worker.stop();
  owner = await account();
  other = await account();
  admin = await account('ADMIN');
  image = await sharp({
    create: { width: 800, height: 600, channels: 3, background: '#376a8f' }
  })
    .withMetadata({ exif: { IFD0: { Artist: 'PRIVATE SYNTHETIC IMAGE METADATA' } } })
    .jpeg()
    .toBuffer();
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  if (orm) {
    const ids = accounts.map((user) => user._id);
    const db = orm.em.getConnection().getDb();
    const assets = await orm.em.fork().find(MediaAsset, { ownerId: { $in: ids } });
    for (const record of assets) {
      const keys = [
        record.originalKey,
        ...record.processingKeys,
        ...(record.variants ? [record.variants.large.key, record.variants.thumbnail.key] : [])
      ];
      if (storage) for (const key of new Set(keys)) await storage.remove(key);
    }
    await db.collection('media_assets').deleteMany({ ownerId: { $in: ids } });
    await db.collection('media_galleries').deleteMany({ ownerId: { $in: ids } });
    await db.collection('listings').deleteMany({ publisherId: { $in: ids } });
    await db.collection('properties').deleteMany({ ownerId: { $in: ids } });
    if (store) {
      const sessions = await store.sessions.find({ userId: { $in: ids } }).toArray();
      await store.tokens.deleteMany({ sessionId: { $in: sessions.map((record) => record._id) } });
      await store.sessions.deleteMany({ _id: { $in: sessions.map((record) => record._id) } });
      await store.users.deleteMany({ _id: { $in: ids } });
    }
  }
  if (app) await app.close();
  if (orm) await orm.close(true);
});

it('processes a real uploaded image, strips metadata and authorizes draft derivatives', async () => {
  const draft = await listing();
  const authorization = await upload(draft.id);
  const original = new URL(authorization.uploadUrl);
  original.search = '';
  expect((await fetch(original)).ok).toBe(false);
  expect((await owner.request(`media/${draft.id}/${authorization.mediaId}/large`)).status).toBe(
    404
  );
  expect((await gallery(draft.id)).items[0]?.state).toBe('queued');
  await worker.dispatch();
  const result = await gallery(draft.id);
  const item = result.items[0]!;
  expect(item.state).toBe('ready');
  expect(result.coverMediaId).toBe(item.id);
  expect(item.variants?.large).toMatchObject({
    width: 800,
    height: 600,
    contentType: 'image/webp'
  });
  expect(item.variants?.thumbnail).toMatchObject({ width: 480, height: 360 });
  const path = `listings/${draft.id}/media/${item.id}/large`;
  const response = await owner.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toContain('image/webp');
  const delivered = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(delivered).metadata();
  expect(metadata.exif).toBeUndefined();
  expect(metadata.icc).toBeUndefined();
  expect(delivered.includes(Buffer.from('PRIVATE SYNTHETIC'))).toBe(false);
  for (const client of [other, admin, new Client(new ObjectId(), '')])
    expect((await client.request(path)).status).toBe(client.token ? 404 : 401);
  const serialized = JSON.stringify(result);
  for (const secret of ['originalKey', 'processingKeys', 'ownerId', 'leaseToken', 'accessKey'])
    expect(serialized).not.toContain(secret);
  const detail = await owner.request(`me/listings/${draft.id}`);
  expect((await detail.json()).submission.missing).not.toContain('processedMedia');
  const record = await asset(item.id);
  await orm.em.fork().nativeUpdate(MediaAsset, record._id, {
    uploadExpiresAt: new Date(Date.now() - 120000),
    cleanupAt: new Date(Date.now() - 1000)
  });
  await worker.cleanup();
  await expect(storage.head(record.originalKey)).rejects.toBeDefined();
  expect((await storage.head(record.variants!.large.key)).bytes).toBeGreaterThan(0);
  expect((await owner.request(path)).status).toBe(200);
});

it('rejects unauthorized, stale, malformed and oversized upload authorizations', async () => {
  const draft = await listing();
  const path = `listings/${draft.id}/media/upload-url`;
  for (const client of [other, admin])
    expect(
      (
        await client.request(path, 'POST', {
          expectedVersion: 1,
          contentType: 'image/jpeg',
          bytes: 1
        })
      ).status
    ).toBe(404);
  for (const patch of [
    { contentType: 'image/svg+xml' },
    { bytes: MAX_IMAGE_BYTES + 1 },
    { bytes: 0 },
    { bytes: '100' },
    { originalKey: 'other-owner-key' }
  ])
    expect(
      (
        await owner.request(path, 'POST', {
          expectedVersion: 1,
          contentType: 'image/jpeg',
          bytes: image.length,
          ...patch
        })
      ).status
    ).toBe(400);
  await authorize(draft.id);
  expect(
    (await owner.request(path, 'POST', { expectedVersion: 1, contentType: 'image/jpeg', bytes: 1 }))
      .status
  ).toBe(409);
});

it('keeps spoofed and oversized stored objects private and ineligible', async () => {
  for (const [bytes, declaredBytes] of [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), null],
    [Buffer.alloc(MAX_IMAGE_BYTES + 1), image.length]
  ] as const) {
    const draft = await listing();
    const authorization = await authorize(draft.id, declaredBytes ?? bytes.length);
    if (bytes.length > MAX_IMAGE_BYTES) {
      const record = await asset(authorization.mediaId);
      await storage.write(record.originalKey, bytes, 'image/jpeg');
    } else await put(authorization, bytes);
    const response = await complete(draft.id, authorization.mediaId);
    expect(response.status).toBe(200);
    await worker.dispatch();
    const result = await gallery(draft.id);
    expect(result.items[0]?.state).toBe('failed');
    expect(result.items[0]?.variants).toBeNull();
    expect(
      (await owner.request(`listings/${draft.id}/media/${authorization.mediaId}/large`)).status
    ).toBe(404);
    const detail = await owner.request(`me/listings/${draft.id}`);
    expect((await detail.json()).submission.missing).toContain('processedMedia');
  }
});

it('rejects expired upload completion and another owner asset association', async () => {
  const draft = await listing();
  const authorization = await authorize(draft.id);
  await put(authorization);
  await orm.em.fork().nativeUpdate(MediaAsset, new ObjectId(authorization.mediaId), {
    uploadExpiresAt: new Date(Date.now() - 1000)
  });
  expect((await complete(draft.id, authorization.mediaId)).status).toBe(409);
  const foreign = await listing(other);
  const response = await other.request(`listings/${foreign.id}/media/complete`, 'POST', {
    expectedVersion: foreign.version,
    mediaId: authorization.mediaId
  });
  expect(response.status).toBe(404);
});

it('validates decoded image format and dimensions rather than trusting upload headers', async () => {
  const png = await sharp(image).png().toBuffer();
  const tooWide = await sharp({
    create: { width: 12001, height: 1, channels: 3, background: '#376a8f' }
  })
    .png()
    .toBuffer();
  for (const [bytes, contentType] of [
    [png, 'image/jpeg'],
    [tooWide, 'image/png']
  ] as const) {
    const draft = await listing();
    const authorization = await upload(draft.id, bytes, contentType);
    await worker.dispatch();
    const record = await asset(authorization.mediaId);
    expect(record.state).toBe('failed');
    expect(record.errorCode).toBe('invalid_image');
    expect(record.variants).toBeNull();
  }
});

it('rejects a real expired storage upload signature', async () => {
  const draft = await listing();
  const authorization = await authorize(draft.id);
  const record = await asset(authorization.mediaId);
  const expired = await storage.signUpload(record.originalKey, record.contentType, image.length, 1);
  await delay(2100);
  const response = await fetch(expired, {
    method: 'PUT',
    headers: authorization.headers,
    body: new Uint8Array(image)
  });
  expect([400, 403]).toContain(response.status);
  expect(await response.text()).toMatch(
    /<(?:Code|Message)>[^<]*(?:expir|date is too old)[^<]*<\/(?:Code|Message)>/i
  );
});

it('allows upload preflight only for the configured browser origin', async () => {
  const draft = await listing();
  const authorization = await authorize(draft.id);
  const preflight = (origin: string) =>
    fetch(authorization.uploadUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type'
      }
    });
  const allowed = await preflight(config.webOrigin);
  expect(allowed.ok).toBe(true);
  expect(allowed.headers.get('access-control-allow-origin')).toBe(config.webOrigin);
  expect(allowed.headers.get('access-control-allow-methods')?.toUpperCase()).toContain('PUT');
  expect(allowed.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
    'content-type'
  );
  const denied = await preflight('https://untrusted.example.invalid');
  expect(denied.ok).toBe(false);
  expect(denied.headers.get('access-control-allow-methods')).toBeNull();
  expect(await denied.text()).toMatch(
    /<(?:Code|Message)>[^<]*(?:cors|origin)[^<]*<\/(?:Code|Message)>/i
  );
});

it('binds storage upload signatures to the authorized content type and size', async () => {
  const draft = await listing();
  const authorization = await authorize(draft.id);
  for (const [headers, bytes] of [
    [{ 'Content-Type': 'image/png' }, image],
    [authorization.headers, Buffer.concat([image, Buffer.from([0])])]
  ] as const) {
    const response = await fetch(authorization.uploadUrl, {
      method: 'PUT',
      headers,
      body: new Uint8Array(bytes)
    });
    expect(response.status).toBe(403);
  }
});

it('handles duplicate completion without adding gallery entries or processing jobs', async () => {
  const draft = await listing();
  const authorization = await upload(draft.id);
  const before = await gallery(draft.id);
  const response = await complete(draft.id, authorization.mediaId, before.version);
  expect(response.status).toBe(200);
  expect((await gallery(draft.id)).items.map((item) => item.id)).toEqual([authorization.mediaId]);
  await worker.dispatch();
  const ready = await asset(authorization.mediaId);
  expect(ready.state).toBe('ready');
  expect(ready.attempts).toBe(1);
});

it('enforces strict database bounds for media states and gallery references', async () => {
  const draft = await listing();
  const authorization = await authorize(draft.id);
  const db = orm.em.getConnection().getDb();
  await expect(
    db
      .collection('media_assets')
      .updateOne(
        { _id: new ObjectId(authorization.mediaId) },
        { $set: { state: 'client-approved' } }
      )
  ).rejects.toMatchObject({ code: 121 });
  for (const mediaIds of [
    [authorization.mediaId, authorization.mediaId],
    Array.from({ length: 21 }, () => new ObjectId().toHexString())
  ])
    await expect(
      db
        .collection('media_galleries')
        .updateOne({ listingId: new ObjectId(draft.id) }, { $set: { mediaIds } })
    ).rejects.toMatchObject({ code: 121 });
  expect((await asset(authorization.mediaId)).state).toBe('awaiting_upload');
  expect((await gallery(draft.id)).items.map((item) => item.id)).toEqual([authorization.mediaId]);
});

it('withdraws published media changes and enforces exact owned ordering and cover', async () => {
  const draft = await listing();
  const first = await upload(draft.id);
  await worker.dispatch();
  const second = await upload(draft.id);
  await worker.dispatch();
  await published(draft.id);
  const publicPath = `media/${draft.id}/${first.mediaId}/large`;
  expect((await owner.request(publicPath)).status).toBe(200);
  const before = await gallery(draft.id);
  for (const mediaIds of [
    [first.mediaId, first.mediaId],
    [first.mediaId, new ObjectId().toHexString()]
  ])
    expect(
      (
        await owner.request(`listings/${draft.id}/media`, 'PATCH', {
          expectedVersion: before.version,
          mediaIds,
          coverMediaId: first.mediaId
        })
      ).status
    ).toBe(400);
  const response = await owner.request(`listings/${draft.id}/media`, 'PATCH', {
    expectedVersion: before.version,
    mediaIds: [second.mediaId, first.mediaId],
    coverMediaId: second.mediaId
  });
  expect(response.status).toBe(200);
  const result: OwnerMediaGallery = await response.json();
  expect(result.items.map((item) => item.id)).toEqual([second.mediaId, first.mediaId]);
  expect(result.coverMediaId).toBe(second.mediaId);
  expect(result.version).toBe(before.version + 1);
  const saved = await orm.em.fork().findOneOrFail(Listing, new ObjectId(draft.id));
  expect(saved.status).toBe('draft');
  expect(saved.approvedVersion).toBeNull();
  expect((await owner.request(publicPath)).status).toBe(404);
  expect(
    (
      await owner.request(`listings/${draft.id}/media/${first.mediaId}`, 'DELETE', {
        expectedVersion: before.version
      })
    ).status
  ).toBe(409);
  const deleted = await owner.request(`listings/${draft.id}/media/${second.mediaId}`, 'DELETE', {
    expectedVersion: result.version
  });
  expect(deleted.status).toBe(200);
  expect((await owner.request(`listings/${draft.id}/media/${second.mediaId}/large`)).status).toBe(
    404
  );
});

it('denies public delivery immediately when current publication or account eligibility changes', async () => {
  const draft = await listing();
  const authorization = await upload(draft.id);
  await worker.dispatch();
  await published(draft.id);
  const anonymous = new Client(new ObjectId(), '');
  const path = `media/${draft.id}/${authorization.mediaId}/large`;
  expect((await anonymous.request(path)).status).toBe(200);
  const current = await gallery(draft.id);
  const listingId = new ObjectId(draft.id);
  for (const patch of [
    { moderationHold: true },
    { expiresAt: new Date(Date.now() - 1000) },
    { publishedAt: new Date(Date.now() + 60000) },
    { approvedVersion: null }
  ]) {
    await orm.em.fork().nativeUpdate(Listing, listingId, patch);
    try {
      expect((await anonymous.request(path)).status).toBe(404);
    } finally {
      await orm.em.fork().nativeUpdate(Listing, listingId, {
        moderationHold: false,
        expiresAt: null,
        publishedAt: new Date(Date.now() - 1000),
        approvedVersion: current.version
      });
    }
  }
  for (const patch of [{ emailVerifiedAt: null }, { status: 'suspended' as const }]) {
    await orm.em.fork().nativeUpdate(User, owner.id, patch);
    try {
      expect((await anonymous.request(path)).status).toBe(404);
    } finally {
      await orm.em.fork().nativeUpdate(User, owner.id, {
        status: 'active',
        emailVerifiedAt: new Date()
      });
    }
  }
  expect((await anonymous.request(path)).status).toBe(200);
});

it('reclaims an interrupted processing lease and retries transient failures from durable state', async () => {
  const draft = await listing();
  const authorization = await upload(draft.id);
  await orm.em.fork().nativeUpdate(MediaAsset, new ObjectId(authorization.mediaId), {
    state: 'processing',
    attempts: 1,
    leaseToken: 'interrupted-synthetic-lease',
    leaseUntil: new Date(Date.now() - 1000)
  });
  await worker.dispatch();
  expect((await asset(authorization.mediaId)).state).toBe('ready');
  const retry = await upload(draft.id);
  const processing = vi
    .spyOn(app.get(ImageProcessor), 'process')
    .mockRejectedValueOnce(new Error('Synthetic transient failure'));
  await worker.dispatch();
  expect((await asset(retry.mediaId)).state).toBe('queued');
  processing.mockRestore();
  await orm.em.fork().nativeUpdate(MediaAsset, new ObjectId(retry.mediaId), {
    availableAt: new Date(Date.now() - 1000)
  });
  await worker.dispatch();
  const recovered = await asset(retry.mediaId);
  expect(recovered.state).toBe('ready');
  expect(recovered.attempts).toBe(2);
});

it('bounds durable retries and never exposes exhausted work', async () => {
  const draft = await listing();
  const authorization = await upload(draft.id);
  vi.spyOn(app.get(ImageProcessor), 'process').mockRejectedValue(new Error('Synthetic outage'));
  for (let attempt = 1; attempt <= 5; attempt++) {
    await worker.dispatch();
    const record = await asset(authorization.mediaId);
    expect(record.attempts).toBe(attempt);
    expect(record.state).toBe(attempt < 5 ? 'queued' : 'failed');
    await orm.em.fork().nativeUpdate(MediaAsset, record._id, {
      availableAt: new Date(Date.now() - 1000)
    });
  }
  await worker.dispatch();
  const exhausted = await asset(authorization.mediaId);
  expect(exhausted.attempts).toBe(5);
  expect(exhausted.errorCode).toBe('processing_failed');
  expect(
    (await owner.request(`listings/${draft.id}/media/${authorization.mediaId}/large`)).status
  ).toBe(404);
});

it('drains persisted queued work through the normal lifecycle timer', async () => {
  const draft = await listing();
  const authorization = await upload(draft.id);
  expect((await asset(authorization.mediaId)).state).toBe('queued');
  worker.onModuleInit();
  try {
    await expect
      .poll(async () => (await asset(authorization.mediaId)).state, {
        timeout: 10000
      })
      .toBe('ready');
  } finally {
    worker.stop();
    await worker.onModuleDestroy();
  }
});

it('reschedules cleanup when a suspended derivative write finishes after deletion cleanup', async () => {
  const draft = await listing();
  const authorization = await upload(draft.id);
  const originalWrite = storage.write.bind(storage);
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let lateKey = '';
  vi.spyOn(storage, 'write').mockImplementationOnce(async (key, bytes, contentType) => {
    lateKey = key;
    started();
    await blocked;
    return originalWrite(key, bytes, contentType);
  });
  const dispatch = worker.dispatch();
  await entered;
  try {
    const current = await gallery(draft.id);
    const response = await owner.request(
      `listings/${draft.id}/media/${authorization.mediaId}`,
      'DELETE',
      {
        expectedVersion: current.version
      }
    );
    expect(response.status).toBe(200);
    await orm.em.fork().nativeUpdate(MediaAsset, new ObjectId(authorization.mediaId), {
      uploadExpiresAt: new Date(Date.now() - 120000),
      leaseUntil: new Date(Date.now() - 120000),
      cleanupAt: new Date(Date.now() - 1000)
    });
    await worker.cleanup();
    expect((await asset(authorization.mediaId)).cleanedAt).toBeInstanceOf(Date);
  } finally {
    release();
    await dispatch;
  }
  const record = await asset(authorization.mediaId);
  expect(record.state).toBe('deleted');
  expect(record.cleanedAt).toBeNull();
  expect((await storage.head(lateKey)).bytes).toBeGreaterThan(0);
  await orm.em.fork().nativeUpdate(MediaAsset, record._id, {
    cleanupAt: new Date(Date.now() - 1000)
  });
  await worker.cleanup();
  await expect(storage.head(lateKey)).rejects.toBeDefined();
});

it('does not restore media deleted while processing and cleans expired orphan uploads', async () => {
  const draft = await listing();
  const authorization = await upload(draft.id);
  const processor = app.get(ImageProcessor);
  const originalProcess = processor.process.bind(processor);
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(processor, 'process').mockImplementationOnce(async (...args) => {
    started();
    await blocked;
    return originalProcess(...args);
  });
  const dispatch = worker.dispatch();
  await entered;
  const current = await gallery(draft.id);
  const response = await owner.request(
    `listings/${draft.id}/media/${authorization.mediaId}`,
    'DELETE',
    {
      expectedVersion: current.version
    }
  );
  release();
  await dispatch;
  expect(response.status).toBe(200);
  expect((await asset(authorization.mediaId)).state).toBe('deleted');
  expect((await gallery(draft.id)).items).toEqual([]);
  expect(
    (await owner.request(`listings/${draft.id}/media/${authorization.mediaId}/large`)).status
  ).toBe(404);
  const orphan = await authorize(draft.id);
  await put(orphan);
  await orm.em.fork().nativeUpdate(MediaAsset, new ObjectId(orphan.mediaId), {
    uploadExpiresAt: new Date(Date.now() - 120000),
    cleanupAt: new Date(Date.now() - 1000)
  });
  await worker.dispatch();
  expect((await asset(orphan.mediaId)).state).toBe('deleted');
  const orphanRecord = await asset(orphan.mediaId);
  await orm.em.fork().nativeUpdate(MediaAsset, orphanRecord._id, {
    cleanupAt: new Date(Date.now() - 1000)
  });
  await worker.cleanup();
  expect((await asset(orphan.mediaId)).cleanedAt).toBeInstanceOf(Date);
  await expect(storage.head(orphanRecord.originalKey)).rejects.toBeDefined();
});
