import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import type {
  CreateInquiryRequest,
  InquiryReceipt,
  OwnerInquiriesResponse
} from '@viedom/contracts';
import { loadConfig } from '../../../scripts/config.mjs';
import { Configuration } from '../src/configuration.js';
import { ApiErrorFilter } from '../src/api-error.filter.js';
import { AuthStore } from '../src/auth/auth.store.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthActions } from '../src/auth/auth.actions.js';
import { AuthMail } from '../src/auth/auth.mail.js';
import { digest } from '../src/auth/auth.crypto.js';
import { localTarget } from '../src/database/local-target.js';
import { initializeOrm, ormOptions } from '../src/database/orm-options.js';
import { provision } from '../src/database/provision.js';
import { Listing, Property, User } from '../src/database/entities.js';
import { approximateLocation } from '../src/database/domain.js';
import { MediaAsset, MediaGallery } from '../src/media/media.entities.js';
import { InquiriesModule } from '../src/inquiries/inquiries.module.js';
import { InquiriesService } from '../src/inquiries/inquiries.service.js';

const config = loadConfig();
const run = new ObjectId().toHexString();
const accounts: User[] = [];
const rateIds = new Set<string>();
let orm: MikroORM;
let app: INestApplication;
let store: AuthStore;
let service: InquiriesService;
let base: string;
let owner: { user: User; token: string };
let other: { user: User; token: string };
let admin: { user: User; token: string };
let sequence = 0;

function input(): CreateInquiryRequest {
  return {
    name: 'Synthetic visitor',
    email: `${run}.${sequence++}@example.invalid`,
    message: 'Please arrange a synthetic property viewing.'
  };
}

async function account(role: 'USER' | 'ADMIN' = 'USER') {
  const user = Object.assign(new User(), {
    email: `${run}.owner${accounts.length}@example.invalid`,
    firstName: 'Synthetic',
    lastName: 'Publisher',
    emailVerifiedAt: new Date(),
    role
  });
  accounts.push(user);
  const em = orm.em.fork();
  em.persist(user);
  await em.flush();
  const session = await store.create({ user }, config.auth.refreshTtl);
  return { user, token: (await app.get(AuthService).response(session)).accessToken };
}

async function listing(extra: Partial<Listing> = {}, publisher = owner.user) {
  const property = Object.assign(new Property(), {
    ownerId: publisher._id,
    type: 'apartment',
    details: { areaM2: 70, bedrooms: 2, bathrooms: 1, floor: 2, yearBuilt: null, amenities: [] },
    address: {
      countryCode: 'GR',
      city: 'Thessaloniki',
      neighborhood: 'Synthetic',
      street: 'CONFIDENTIAL SYNTHETIC STREET'
    },
    privateLocation: { type: 'Point', coordinates: [22.94, 40.64] }
  });
  property.publicLocation = approximateLocation(property.privateLocation);
  const record = Object.assign(new Listing(), {
    propertyId: property._id,
    publisherId: publisher._id,
    propertyVersion: property.version,
    propertyType: property.type,
    areaM2: 70,
    bedrooms: 2,
    bathrooms: 1,
    city: property.address.city,
    neighborhood: property.address.neighborhood,
    publicLocation: property.publicLocation,
    title: 'Synthetic inquiry apartment',
    description: 'Synthetic description',
    status: 'published',
    submittedVersion: 1,
    approvedVersion: 1,
    reviewedById: new ObjectId(),
    publishedAt: new Date(Date.now() - 1000),
    ...extra
  });
  const asset = Object.assign(new MediaAsset(), {
    listingId: record._id,
    ownerId: publisher._id,
    state: 'ready',
    originalKey: `synthetic-inquiries/${run}/${new ObjectId()}`,
    contentType: 'image/jpeg',
    expectedBytes: 100,
    uploadExpiresAt: new Date(Date.now() + 60_000)
  });
  const large = `${asset.originalKey}/large`;
  const thumbnail = `${asset.originalKey}/thumbnail`;
  asset.processingKeys = [large, thumbnail];
  asset.variants = {
    large: { key: large, width: 800, height: 600, bytes: 100 },
    thumbnail: { key: thumbnail, width: 400, height: 300, bytes: 50 }
  };
  const gallery = Object.assign(new MediaGallery(), {
    listingId: record._id,
    ownerId: publisher._id,
    mediaIds: [asset._id.toHexString()],
    coverMediaId: asset._id.toHexString()
  });
  const db = orm.em.getConnection().getDb();
  await db.collection('properties').insertOne({ ...property });
  await db.collection('listings').insertOne({ ...record });
  await db.collection('media_assets').insertOne({ ...asset });
  await db.collection('media_galleries').insertOne({ ...gallery });
  return { record, property, asset, gallery };
}

function request(
  path: string,
  method = 'GET',
  body?: unknown,
  token = '',
  headers: Record<string, string> = {}
) {
  return fetch(`${base}/api/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: config.webOrigin,
      'X-Inquiry-Request': '1',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

beforeAll(async () => {
  const target = localTarget(config, true);
  orm = await initializeOrm(ormOptions(target.uri, target.dbName));
  await provision(orm);
  store = new AuthStore(orm);
  const limit = store.limit.bind(store);
  store.limit = async (scope, key, maximum, seconds, session) => {
    const isolated = `${run}:${key}`;
    const bucket = Math.floor(Date.now() / (seconds * 1000));
    for (const value of [bucket, bucket + 1]) rateIds.add(digest(`${scope}:${isolated}:${value}`));
    await limit(scope, isolated, maximum, seconds, session);
  };
  const module = await Test.createTestingModule({ imports: [InquiriesModule] })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .overrideProvider(CoreMikroORM)
    .useValue(orm)
    .overrideProvider(Configuration)
    .useValue({ values: config })
    .overrideProvider(AuthStore)
    .useValue(store)
    .overrideProvider(AuthMail)
    .useValue({ send: vi.fn() })
    .compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );
  app.useGlobalFilters(new ApiErrorFilter());
  await app.listen(0, '127.0.0.1');
  await app.get(AuthActions).onModuleDestroy();
  base = await app.getUrl();
  service = app.get(InquiriesService);
  owner = await account();
  other = await account();
  admin = await account('ADMIN');
});

afterAll(async () => {
  if (orm) {
    const db = orm.em.getConnection().getDb();
    const ids = accounts.map((account) => account._id);
    for (const collection of ['inquiries', 'listings'])
      await db.collection(collection).deleteMany({ publisherId: { $in: ids } });
    for (const collection of ['media_assets', 'media_galleries', 'properties'])
      await db.collection(collection).deleteMany({ ownerId: { $in: ids } });
    if (store) {
      const sessions = await store.sessions.find({ userId: { $in: ids } }).toArray();
      await store.tokens.deleteMany({ sessionId: { $in: sessions.map((value) => value._id) } });
      await store.sessions.deleteMany({ userId: { $in: ids } });
      await store.users.deleteMany({ _id: { $in: ids } });
      await store.rates.deleteMany({ _id: { $in: [...rateIds] } });
    }
  }
  await app?.close();
  await orm?.close(true);
});

it('stores guest and authenticated inquiries with server-derived routing and private allowlisted responses', async () => {
  const { record } = await listing();
  const guest = await request(`listings/${record._id}/inquiries`, 'POST', input());
  expect(guest.status).toBe(201);
  expect(guest.headers.get('cache-control')).toBe('no-store');
  const receipt: InquiryReceipt = await guest.json();
  expect(Object.keys(receipt)).toEqual(['id']);
  const row = await orm.em
    .getConnection()
    .getDb()
    .collection('inquiries')
    .findOne({ _id: new ObjectId(receipt.id) });
  expect(row?.publisherId).toEqual(owner.user._id);
  expect(row?.senderId).toBeNull();
  expect(row?.status).toBe('unread');
  const authenticated = await request(
    `listings/${record._id}/inquiries`,
    'POST',
    input(),
    other.token
  );
  expect(authenticated.status).toBe(201);
  const authReceipt: InquiryReceipt = await authenticated.json();
  const authRow = await orm.em
    .getConnection()
    .getDb()
    .collection('inquiries')
    .findOne({ _id: new ObjectId(authReceipt.id) });
  expect(authRow?.senderId).toEqual(other.user._id);
  const inbox = await request('me/inquiries', 'GET', undefined, owner.token);
  expect(inbox.status).toBe(200);
  expect(inbox.headers.get('x-robots-tag')).toBe('noindex');
  const page: OwnerInquiriesResponse = await inbox.json();
  expect(page.items.map((item) => item.id)).toEqual(
    expect.arrayContaining([receipt.id, authReceipt.id])
  );
  expect(JSON.stringify(page)).not.toContain('senderId');
  expect(JSON.stringify(page)).not.toContain('publisherId');
  expect(JSON.stringify(page)).not.toContain('CONFIDENTIAL SYNTHETIC STREET');
});

it('denies malformed, nonpublic and stale publication, property, publisher and media states', async () => {
  await expect(service.submit('bad', input(), `${run}:invalid`, null)).rejects.toMatchObject({
    status: 404
  });
  for (const patch of [
    { status: 'draft' },
    { status: 'paused' },
    { moderationHold: true },
    { deletedAt: new Date() },
    { expiresAt: new Date(Date.now() - 1000) },
    { approvedVersion: null },
    { publishedAt: new Date(Date.now() + 60000) }
  ] as Partial<Listing>[]) {
    const { record } = await listing(patch);
    await expect(
      service.submit(record._id.toHexString(), input(), `${run}:${record._id}`, null)
    ).rejects.toMatchObject({ status: 404 });
  }
  const db = orm.em.getConnection().getDb();
  for (const target of ['property', 'gallery', 'asset', 'publisher'] as const) {
    const publisher = target === 'publisher' ? await account() : owner;
    const fixture = await listing({}, publisher.user);
    if (target === 'property')
      await db
        .collection('properties')
        .updateOne({ _id: fixture.property._id }, { $inc: { version: 1 } });
    if (target === 'gallery')
      await db
        .collection('media_galleries')
        .updateOne({ _id: fixture.gallery._id }, { $set: { mediaIds: [], coverMediaId: null } });
    if (target === 'asset')
      await db
        .collection('media_assets')
        .updateOne({ _id: fixture.asset._id }, { $set: { state: 'failed' } });
    if (target === 'publisher')
      await store.users.updateOne({ _id: publisher.user._id }, { $set: { status: 'suspended' } });
    await expect(
      service.submit(fixture.record._id.toHexString(), input(), `${run}:${target}`, null)
    ).rejects.toMatchObject({ status: 404 });
  }
});

it('protects submission origin, optional authentication, fields and owner mutations', async () => {
  const { record } = await listing();
  for (const body of [
    { ...input(), message: 'short' },
    { ...input(), website: 'spam' },
    { ...input(), publisherId: other.user._id.toHexString() },
    { ...input(), email: { $ne: null } },
    { ...input(), phone: null }
  ])
    expect((await request(`listings/${record._id}/inquiries`, 'POST', body)).status).toBe(400);
  expect(
    (
      await request(`listings/${record._id}/inquiries`, 'POST', input(), '', {
        Origin: 'https://evil.invalid'
      })
    ).status
  ).toBe(403);
  expect(
    (
      await request(`listings/${record._id}/inquiries`, 'POST', input(), '', {
        'X-Inquiry-Request': ''
      })
    ).status
  ).toBe(403);
  expect(
    (await request(`listings/${record._id}/inquiries`, 'POST', input(), 'invalid')).status
  ).toBe(401);
  expect((await request('me/inquiries')).status).toBe(401);
  const receipt = await service.submit(record._id.toHexString(), input(), `${run}:owned`, null);
  const updated = await request(
    `me/inquiries/${receipt.id}`,
    'PATCH',
    { status: 'read' },
    owner.token
  );
  expect(updated.status).toBe(200);
  expect((await updated.json()).status).toBe('read');
  for (const token of [other.token, admin.token]) {
    expect(
      (await request(`me/inquiries/${receipt.id}`, 'PATCH', { status: 'archived' }, token)).status
    ).toBe(404);
    const page: OwnerInquiriesResponse = await (
      await request('me/inquiries', 'GET', undefined, token)
    ).json();
    expect(page.items).toEqual([]);
  }
  expect(
    (
      await request(`me/inquiries/${receipt.id}`, 'PATCH', { status: 'read' }, owner.token, {
        Origin: 'https://evil.invalid'
      })
    ).status
  ).toBe(403);
});

it('paginates equal timestamps without duplicates and binds cursors to the publisher', async () => {
  const { record } = await listing();
  const date = new Date('2026-01-01T00:00:00Z');
  const ids: string[] = [];
  for (let index = 0; index < 3; index++)
    ids.push(
      (await service.submit(record._id.toHexString(), input(), `${run}:page:${index}`, null)).id
    );
  await orm.em
    .getConnection()
    .getDb()
    .collection('inquiries')
    .updateMany({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, { $set: { createdAt: date } });
  const seen = new Set<string>();
  let cursor: string | undefined;
  let iterations = 0;
  do {
    const page = await service.list(owner.user._id, { limit: 1, ...(cursor ? { cursor } : {}) });
    for (const item of page.items) {
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
    }
    if (page.nextCursor)
      await expect(
        service.list(other.user._id, { limit: 1, cursor: page.nextCursor })
      ).rejects.toMatchObject({ status: 400 });
    cursor = page.nextCursor ?? undefined;
    expect(++iterations).toBeLessThan(20);
  } while (cursor);
  expect([...seen]).toEqual(expect.arrayContaining(ids));
});

it('enforces persistent deduplication, per-listing and contact abuse limits', async () => {
  const { record } = await listing();
  const duplicate = input();
  await service.submit(record._id.toHexString(), duplicate, `${run}:duplicate:1`, null);
  await expect(
    service.submit(record._id.toHexString(), duplicate, `${run}:duplicate:2`, null)
  ).rejects.toMatchObject({ status: 429 });
  for (let index = 0; index < 3; index++)
    await service.submit(record._id.toHexString(), input(), `${run}:listing-limit`, null);
  await expect(
    service.submit(record._id.toHexString(), input(), `${run}:listing-limit`, null)
  ).rejects.toMatchObject({ status: 429 });
  const email = input().email;
  for (let index = 0; index < 5; index++)
    await service.submit(
      record._id.toHexString(),
      { ...input(), email, message: `Synthetic unique inquiry message number ${index}.` },
      `${run}:email:${index}`,
      null
    );
  await expect(
    service.submit(record._id.toHexString(), { ...input(), email }, `${run}:email:exhausted`, null)
  ).rejects.toMatchObject({ status: 429 });
});

it('rolls duplicate reservations back on insert failure and accepts only one concurrent duplicate', async () => {
  const { record } = await listing();
  const contact = input();
  const before = await store.users.findOne({ _id: owner.user._id });
  await expect(
    service.submit(
      record._id.toHexString(),
      { ...contact, name: 'x'.repeat(101) },
      `${run}:rollback`,
      null
    )
  ).rejects.toMatchObject({ code: 121 });
  const after = await store.users.findOne({ _id: owner.user._id });
  expect(after?.version).toBe(before?.version);
  const records = orm.em.getConnection().getDb().collection('inquiries');
  expect(await records.countDocuments({ listingId: record._id, email: contact.email })).toBe(0);
  await expect(
    service.submit(record._id.toHexString(), contact, `${run}:rollback`, null)
  ).resolves.toHaveProperty('id');
  const repeated = input();
  const results = await Promise.allSettled([
    service.submit(record._id.toHexString(), repeated, `${run}:concurrent:1`, null),
    service.submit(record._id.toHexString(), repeated, `${run}:concurrent:2`, null)
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const denied = results.find((result) => result.status === 'rejected');
  expect(denied?.status === 'rejected' ? denied.reason : null).toMatchObject({ status: 429 });
  expect(await records.countDocuments({ listingId: record._id, email: repeated.email })).toBe(1);
});

it('serializes inquiries with withdrawal and leaves no public entry after withdrawal wins', async () => {
  const { record } = await listing();
  const results = await Promise.allSettled([
    service.submit(record._id.toHexString(), input(), `${run}:racing`, null),
    orm.em
      .getConnection()
      .getDb()
      .collection('listings')
      .updateOne({ _id: record._id }, { $set: { status: 'paused', updatedAt: new Date() } })
  ]);
  expect(results[1].status).toBe('fulfilled');
  if (results[0].status === 'rejected') expect(results[0].reason).toMatchObject({ status: 404 });
  await expect(
    service.submit(record._id.toHexString(), input(), `${run}:after-withdrawal`, null)
  ).rejects.toMatchObject({ status: 404 });
});
