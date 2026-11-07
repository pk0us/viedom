import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import type {
  OwnerListingDetail,
  OwnerListingPreview,
  OwnerListingsResponse,
  OwnerProperty,
  PropertyContent
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
import { Listing, Property, User } from '../src/database/entities.js';
import { PropertySnapshots, propertySnapshot } from '../src/database/snapshots.js';
import { PropertiesModule } from '../src/properties/properties.module.js';
import { ListingsModule } from '../src/listings/listings.module.js';
import { ListingMediaPolicy, ListingsPolicy } from '../src/listings/listings.policy.js';
import { OpenApiController } from '../src/openapi.js';
import { MediaAsset, MediaGallery } from '../src/media/media.entities.js';

const config = loadConfig();
const run = new ObjectId().toHexString();
let orm: MikroORM;
let app: INestApplication;
let base: string;
let store: AuthStore;
let media: ListingMediaPolicy;
const accounts: User[] = [];
let owner: Client;
let other: Client;
let unverified: Client;
let admin: Client;

const propertyInput: PropertyContent = {
  type: 'studio',
  details: {
    areaM2: 45,
    bedrooms: 0,
    bathrooms: 1,
    floor: 0,
    yearBuilt: null,
    amenities: ['lift']
  },
  address: {
    countryCode: 'GR',
    city: 'Thessaloniki',
    neighborhood: 'Synthetic',
    street: 'PRIVATE SYNTHETIC STREET'
  },
  privateLocation: { type: 'Point', coordinates: [22.9444, 40.6401] }
};
const listingInput = {
  transactionType: 'rent',
  title: 'Synthetic studio listing',
  description: 'Synthetic property description with no real contact details.',
  priceMinor: 65000,
  currency: 'EUR'
};

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

async function account(verified = true, role: 'USER' | 'ADMIN' = 'USER') {
  const user = Object.assign(new User(), {
    email: `${run}.${accounts.length}@example.invalid`,
    firstName: 'Synthetic',
    lastName: 'Owner',
    emailVerifiedAt: verified ? new Date() : null,
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

async function property(client = owner): Promise<OwnerProperty> {
  const response = await client.request('properties', 'POST', propertyInput);
  expect(response.status).toBe(201);
  return response.json();
}
async function listing(client = owner, canonical?: OwnerProperty): Promise<OwnerListingDetail> {
  const p = canonical ?? (await property(client));
  const response = await client.request('listings', 'POST', {
    ...listingInput,
    propertyId: p.id,
    expectedPropertyVersion: p.version
  });
  expect(response.status).toBe(201);
  return response.json();
}
async function state(
  listing: OwnerListingDetail,
  status: Listing['status'],
  extra: Partial<Listing> = {}
) {
  await orm.em.fork().nativeUpdate(Listing, new ObjectId(listing.id), {
    status,
    submittedVersion: listing.version,
    approvedVersion: ['published', 'paused'].includes(status) ? listing.version : null,
    reviewedById: accounts[3]!._id,
    publishedAt: new Date(Date.now() - 1000),
    ...extra
  });
}
async function read(id: string, client = owner): Promise<OwnerListingDetail> {
  const response = await client.request(`me/listings/${id}`);
  expect(response.status).toBe(200);
  return response.json();
}
function action(id: string, action: string, expectedVersion: number, client = owner) {
  return client.request(`listings/${id}/${action}`, 'POST', { expectedVersion });
}
async function stored(id: string) {
  return orm.em.fork().findOneOrFail(Listing, new ObjectId(id));
}

beforeAll(async () => {
  const target = localTarget(config, true);
  orm = await initializeOrm(ormOptions(target.uri, target.dbName));
  await provision(orm);
  const testing = await Test.createTestingModule({
    imports: [AuthModule, PropertiesModule, ListingsModule],
    controllers: [OpenApiController]
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
  media = app.get(ListingMediaPolicy);
  owner = await account();
  other = await account();
  unverified = await account(false);
  admin = await account(true, 'ADMIN');
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (orm) {
    const ids = accounts.map((user) => user._id);
    const db = orm.em.getConnection().getDb();
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

it('saves/reopens private property and draft content with explicit projections and private headers', async () => {
  const p = await property(unverified);
  expect(p).toMatchObject({ ...propertyInput, version: 1 });
  expect(p.publicLocation.coordinates).not.toEqual(p.privateLocation.coordinates);
  const l = await listing(unverified, p);
  expect(l).toMatchObject({ ...listingInput, version: 1, status: 'draft', property: { id: p.id } });
  expect(l.submission).toEqual({ canSubmit: false, missing: ['verifiedEmail', 'processedMedia'] });
  const response = await unverified.request(`me/listings/${l.id}`);
  expect(await response.json()).toMatchObject(l);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-robots-tag')).toBe('noindex');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const updated = await unverified.request(`listings/${l.id}`, 'PATCH', {
    ...listingInput,
    title: '',
    description: '',
    priceMinor: 1,
    expectedVersion: 1
  });
  expect(updated.status).toBe(200);
  expect(await read(l.id, unverified)).toMatchObject({
    title: '',
    description: '',
    priceMinor: 1,
    version: 2,
    status: 'draft'
  });
  const json = JSON.stringify(await read(l.id, unverified));
  for (const field of [
    'passwordHash',
    'fixtureKey',
    'ownerId',
    'publisherId',
    'reviewedById',
    'accessToken'
  ])
    expect(json).not.toContain(field);
});

it('hides another owner resources for reads, writes, actions and property linking, including from ADMIN', async () => {
  const p = await property();
  const l = await listing(owner, p);
  for (const client of [other, admin]) {
    for (const [path, method, body] of [
      [`properties/${p.id}`, 'GET', undefined],
      [`properties/${p.id}`, 'PATCH', { ...propertyInput, expectedVersion: 1 }],
      [`me/listings/${l.id}`, 'GET', undefined],
      [`me/listings/${l.id}/preview`, 'GET', undefined],
      [`listings/${l.id}`, 'PATCH', { ...listingInput, expectedVersion: 1 }],
      ['listings', 'POST', { ...listingInput, propertyId: p.id, expectedPropertyVersion: 1 }]
    ] as const)
      expect((await client.request(path, method, body)).status).toBe(404);
    for (const name of ['submit', 'pause', 'resume', 'archive'])
      expect((await action(l.id, name, 1, client)).status).toBe(404);
    const page: OwnerListingsResponse = await (await client.request('me/listings')).json();
    expect(page.items.some((item) => item.id === l.id)).toBe(false);
  }
  expect((await owner.request(`properties/${new ObjectId()}`)).status).toBe(404);
});

it('previews only saved public fields and owned processed derivatives while retaining submission rules', async () => {
  const l = await listing();
  const em = orm.em.fork();
  const ready = () => {
    const asset = Object.assign(new MediaAsset(), {
      listingId: new ObjectId(l.id),
      ownerId: owner.id,
      state: 'ready',
      originalKey: `private-original/${new ObjectId()}`,
      contentType: 'image/jpeg',
      expectedBytes: 100,
      uploadExpiresAt: new Date(Date.now() + 60_000)
    });
    const large = `private-processed/${asset._id}/large`;
    const thumbnail = `private-processed/${asset._id}/thumbnail`;
    asset.processingKeys = [large, thumbnail];
    asset.variants = {
      large: { key: large, width: 800, height: 600, bytes: 100 },
      thumbnail: { key: thumbnail, width: 400, height: 300, bytes: 50 }
    };
    return asset;
  };
  const first = ready();
  const second = ready();
  const processing = Object.assign(ready(), { state: 'processing', variants: null });
  const failed = Object.assign(ready(), {
    state: 'failed',
    errorCode: 'invalid_image',
    variants: null
  });
  const foreign = Object.assign(ready(), { ownerId: other.id });
  const invalid = Object.assign(ready(), { processingKeys: [] });
  const gallery = Object.assign(new MediaGallery(), {
    listingId: new ObjectId(l.id),
    ownerId: owner.id,
    mediaIds: [second, processing, foreign, failed, invalid, first].map((asset) =>
      asset._id.toHexString()
    ),
    coverMediaId: processing._id.toHexString()
  });
  em.persist([first, second, processing, failed, foreign, invalid, gallery]);
  await em.flush();

  const response = await owner.request(`me/listings/${l.id}/preview`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-robots-tag')).toBe('noindex');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const preview: OwnerListingPreview = await response.json();
  expect(Object.keys(preview).sort()).toEqual(['content', 'status', 'submission', 'version']);
  expect(preview.status).toBe('draft');
  expect(preview.submission).toEqual({ canSubmit: false, missing: ['processedMedia'] });
  expect(preview.content).toMatchObject({
    ...listingInput,
    property: {
      type: propertyInput.type,
      details: propertyInput.details,
      address: { countryCode: 'GR', city: 'Thessaloniki', neighborhood: 'Synthetic' },
      publicLocation: l.property.publicLocation
    },
    media: { coverMediaId: null }
  });
  expect(preview.content.media.items.map((asset) => asset.id)).toEqual([
    second._id.toHexString(),
    first._id.toHexString()
  ]);
  expect(preview.content.media.items[0]!.variants.large).toEqual({
    url: `${config.public.apiBaseUrl}/listings/${l.id}/media/${second._id.toHexString()}/large`,
    width: 800,
    height: 600,
    bytes: 100,
    contentType: 'image/webp'
  });
  const serialized = JSON.stringify(preview);
  for (const privateValue of [
    'street',
    propertyInput.address.street,
    'privateLocation',
    'propertyId',
    'ownerId',
    'publisherId',
    'originalKey',
    'processingKeys',
    'private-original',
    'private-processed',
    l.property.id,
    owner.id.toHexString(),
    processing._id.toHexString(),
    failed._id.toHexString(),
    foreign._id.toHexString(),
    invalid._id.toHexString()
  ])
    expect(serialized).not.toContain(privateValue);
  expect(preview.content.property.publicLocation.coordinates).not.toEqual(
    propertyInput.privateLocation.coordinates
  );
  expect((await action(l.id, 'submit', l.version)).status).toBe(409);

  await orm.em.fork().nativeUpdate(MediaGallery, gallery._id, {
    mediaIds: [second._id.toHexString(), first._id.toHexString()],
    coverMediaId: first._id.toHexString()
  });
  const complete = await owner.request(`me/listings/${l.id}/preview`);
  expect((await complete.json()).submission).toEqual({ canSubmit: true, missing: [] });
  const submitted = await action(l.id, 'submit', l.version);
  expect(submitted.status).toBe(200);
  expect(await submitted.json()).toMatchObject({
    status: 'pending_review',
    version: 2,
    publishedAt: null
  });
  expect((await stored(l.id)).approvedVersion).toBeNull();
  expect((await action(l.id, 'submit', 2)).status).toBe(409);
});

it('requires a bearer session for preview and permits the owning unverified user to inspect missing requirements', async () => {
  const l = await listing(unverified);
  const anonymous = new Client(new ObjectId(), '');
  const denied = await anonymous.request(`me/listings/${l.id}/preview`);
  expect(denied.status).toBe(401);
  expect(denied.headers.get('cache-control')).toBe('no-store');
  const response = await unverified.request(`me/listings/${l.id}/preview`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: 'draft',
    submission: { canSubmit: false, missing: ['verifiedEmail', 'processedMedia'] },
    content: { media: { coverMediaId: null, items: [] } }
  });
});

it('rejects a preview when saved content changes while its readiness is being read', async () => {
  const l = await listing();
  vi.spyOn(media, 'ready').mockImplementationOnce(async () => {
    await orm.em.fork().nativeUpdate(Listing, new ObjectId(l.id), { version: 2 });
    return false;
  });
  const response = await owner.request(`me/listings/${l.id}/preview`);
  expect(response.status).toBe(409);
  expect(response.headers.get('cache-control')).toBe('no-store');
});

it('rejects privileged fields, nested operators, invalid money, coordinates and malformed versions/queries', async () => {
  const p = await property();
  const l = await listing(owner, p);
  for (const patch of [
    { ownerId: owner.id.toHexString() },
    { publicLocation: propertyInput.privateLocation },
    { details: { ...propertyInput.details, bedrooms: 0.5 } },
    { details: { ...propertyInput.details, yearBuilt: undefined } },
    { details: { ...propertyInput.details, amenities: ['lift', 'lift'] } },
    { address: { ...propertyInput.address, city: { $ne: null } } },
    { address: { ...propertyInput.address, unknown: 'private' } },
    { privateLocation: { type: 'Point', coordinates: [22, 91] } },
    { privateLocation: { type: 'Point', coordinates: [181, 40] } },
    { privateLocation: { type: 'Point', coordinates: [22, 40, 3] } },
    { privateLocation: { type: 'Point', coordinates: ['22', 40] } },
    { details: null },
    { type: 'castle' }
  ])
    expect((await owner.request('properties', 'POST', { ...propertyInput, ...patch })).status).toBe(
      400
    );
  for (const patch of [
    { status: 'published' },
    { publisherId: owner.id.toHexString() },
    { approvedVersion: 1 },
    { moderationHold: false },
    { expiresAt: '2099-01-01T00:00:00Z' },
    { media: ['owned'] },
    { propertyId: p.id },
    { currency: 'USD' },
    { priceMinor: 0 },
    { priceMinor: 1.5 },
    { priceMinor: '65000' },
    { title: { $gt: '' } },
    { expectedVersion: null },
    { expectedVersion: Number.MAX_SAFE_INTEGER }
  ])
    expect(
      (
        await owner.request(`listings/${l.id}`, 'PATCH', {
          ...listingInput,
          expectedVersion: 1,
          ...patch
        })
      ).status
    ).toBe(400);
  for (const path of [
    'me/listings?limit=0',
    'me/listings?limit=51',
    'me/listings?limit=1.5',
    'me/listings?limit=0x10',
    'me/listings?cursor=garbage',
    'me/listings?status=secret',
    'me/listings?unknown=true',
    'properties/not-an-id'
  ])
    expect((await owner.request(path)).status).toBe(400);
  expect((await action(l.id, 'archive', 0)).status).toBe(400);
  expect((await action(l.id, 'archive', '1' as unknown as number)).status).toBe(400);
  expect(
    (
      await owner.request(`listings/${l.id}/archive`, 'POST', {
        expectedVersion: 1,
        status: 'published'
      })
    ).status
  ).toBe(400);
});

it('requires live bearer sessions for private endpoints and never exposes private data via public listing URLs', async () => {
  const l = await listing();
  const guest = new Client(new ObjectId(), '');
  for (const path of ['me/listings', `me/listings/${l.id}`, `properties/${l.propertyId}`]) {
    const response = await guest.request(path);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('PRIVATE SYNTHETIC');
  }
  for (const client of [guest, owner, admin]) {
    expect((await client.request(`listings/${l.id}`)).status).toBe(404);
    expect(
      (await client.request(`listings/${l.id}/approve`, 'POST', { expectedVersion: 1 })).status
    ).toBe(404);
  }
  const disabled = await account();
  await store.users.updateOne({ _id: disabled.id }, { $set: { status: 'suspended' } });
  expect((await disabled.request('properties', 'POST', propertyInput)).status).toBe(401);
  const disabledCount = await orm.em.fork().count(Property, { ownerId: disabled.id });
  expect(disabledCount).toBe(0);
});

it('blocks photo-free and incomplete submission, and unverified submission even with a valid draft', async () => {
  const l = await listing();
  expect(l.submission).toEqual({ canSubmit: false, missing: ['processedMedia'] });
  expect((await action(l.id, 'submit', 1)).status).toBe(409);
  expect((await action(l.id, 'resume', 1)).status).toBe(409);
  const u = await listing(unverified);
  expect((await action(u.id, 'submit', 1, unverified)).status).toBe(403);
  vi.spyOn(media, 'ready').mockResolvedValue(true);
  const invalid = await owner.request(`listings/${l.id}`, 'PATCH', {
    ...listingInput,
    title: 'small',
    description: '',
    expectedVersion: 1
  });
  expect(invalid.status).toBe(200);
  expect((await action(l.id, 'submit', 2)).status).toBe(409);
  expect((await read(l.id)).submission.missing).toEqual(['title', 'description']);
});

it('captures submitted versions, conflicts duplicate/stale transitions and supports rejected resubmission', async () => {
  vi.spyOn(media, 'ready').mockResolvedValue(true);
  const l = await listing();
  expect((await action(l.id, 'pause', 1)).status).toBe(409);
  const submitted = await action(l.id, 'submit', 1);
  expect(submitted.status).toBe(200);
  expect(await submitted.json()).toMatchObject({
    version: 2,
    status: 'pending_review',
    submittedVersion: 2
  });
  expect((await action(l.id, 'submit', 1)).status).toBe(409);
  expect((await action(l.id, 'submit', 2)).status).toBe(409);
  const edit = await owner.request(`listings/${l.id}`, 'PATCH', {
    ...listingInput,
    title: 'New public content',
    expectedVersion: 2
  });
  expect(edit.status).toBe(200);
  expect(await edit.json()).toMatchObject({ status: 'draft', version: 3, submittedVersion: null });
  expect((await stored(l.id)).approvedVersion).toBeNull();
  await state(await read(l.id), 'rejected');
  expect((await action(l.id, 'submit', 3)).status).toBe(200);
  expect(await read(l.id)).toMatchObject({
    status: 'pending_review',
    version: 4,
    submittedVersion: 4
  });
});

it('withdraws published edits and routes pause/resume through review while retaining moderation holds', async () => {
  vi.spyOn(media, 'ready').mockResolvedValue(true);
  const l = await listing();
  await state(l, 'published', { expiresAt: new Date(Date.now() + 10000) });
  const paused = await action(l.id, 'pause', 1);
  expect(paused.status).toBe(200);
  expect(await paused.json()).toMatchObject({ status: 'paused', version: 2, publishedAt: null });
  expect((await stored(l.id)).approvedVersion).toBeNull();
  expect((await action(l.id, 'resume', 2)).status).toBe(200);
  const pending = await read(l.id);
  expect(pending).toMatchObject({ status: 'pending_review', version: 3 });
  await state(pending, 'published', { moderationHold: true });
  const edited = await owner.request(`listings/${l.id}`, 'PATCH', {
    ...listingInput,
    expectedVersion: 3
  });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({
    status: 'draft',
    version: 4,
    moderationHold: true,
    publishedAt: null
  });
  expect((await action(l.id, 'submit', 4)).status).toBe(409);
});

it('makes archive terminal and synchronizes all snapshots including archive and hold in a single property edit', async () => {
  const p = await property();
  const first = await listing(owner, p);
  const second = await listing(owner, p);
  const third = await listing(owner, p);
  await state(first, 'published');
  await state(second, 'pending_review', { moderationHold: true });
  expect((await action(third.id, 'archive', 1)).status).toBe(200);
  for (const name of ['archive', 'submit', 'resume', 'pause'])
    expect((await action(third.id, name, 2)).status).toBe(409);
  expect(
    (await owner.request(`listings/${third.id}`, 'PATCH', { ...listingInput, expectedVersion: 2 }))
      .status
  ).toBe(409);
  const update = {
    ...propertyInput,
    details: { ...propertyInput.details, areaM2: 90 },
    privateLocation: { type: 'Point', coordinates: [22.96, 40.66] },
    expectedVersion: 1
  };
  const response = await owner.request(`properties/${p.id}`, 'PATCH', update);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ version: 2, details: { areaM2: 90 } });
  expect(await app.get(PropertySnapshots).drift(new ObjectId(p.id))).toEqual([]);
  expect(await read(first.id)).toMatchObject({
    status: 'draft',
    propertyVersion: 2,
    version: 2,
    publishedAt: null
  });
  expect(await read(second.id)).toMatchObject({
    status: 'draft',
    moderationHold: true,
    propertyVersion: 2
  });
  expect(await read(third.id)).toMatchObject({
    status: 'archived',
    propertyVersion: 2,
    version: 3
  });
  expect((await owner.request(`properties/${p.id}`, 'PATCH', update)).status).toBe(409);
});

it('returns stable bounded owner pagination with timestamp ties and no cross-owner entries', async () => {
  const client = await account();
  const p = await property(client);
  const listings = await Promise.all([listing(client, p)]);
  for (let i = 0; i < 4; i++) listings.push(await listing(client, p));
  const ids = listings.map((row) => new ObjectId(row.id));
  await orm.em
    .getConnection()
    .getDb()
    .collection('listings')
    .updateMany({ _id: { $in: ids } }, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });
  const found: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await client.request(
      `me/listings?limit=2&status=draft${cursor ? `&cursor=${cursor}` : ''}`
    );
    expect(response.status).toBe(200);
    const page: OwnerListingsResponse = await response.json();
    expect(page.items.length).toBeLessThanOrEqual(2);
    found.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(found).toEqual(
    ids
      .map((value) => value.toHexString())
      .sort()
      .reverse()
  );
  expect((await (await client.request('me/listings?status=archived')).json()).items).toEqual([]);
});

it('allows one concurrent expected-version listing writer and rolls the losing write back', async () => {
  const l = await listing();
  const responses = await Promise.all(
    ['First concurrent title', 'Second concurrent title'].map((title) =>
      owner.request(`listings/${l.id}`, 'PATCH', { ...listingInput, title, expectedVersion: 1 })
    )
  );
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect((await read(l.id)).version).toBe(2);
});

it('serializes concurrent listing creation against canonical edits without stale snapshots', async () => {
  for (let i = 0; i < 3; i++) {
    const p = await property();
    const responses = await Promise.all([
      owner.request('listings', 'POST', {
        ...listingInput,
        propertyId: p.id,
        expectedPropertyVersion: 1
      }),
      owner.request(`properties/${p.id}`, 'PATCH', {
        ...propertyInput,
        details: { ...propertyInput.details, areaM2: 77 },
        expectedVersion: 1
      })
    ]);
    expect(responses.every((response) => [200, 201, 409].includes(response.status))).toBe(true);
    expect(responses.some((response) => response.status !== 409)).toBe(true);
    expect(await app.get(PropertySnapshots).drift(new ObjectId(p.id))).toEqual([]);
  }
});

it('enforces the 100-advertisement creation bound including simultaneous last-slot creation', async () => {
  const p = await property();
  const canonical = await orm.em.fork().findOneOrFail(Property, new ObjectId(p.id));
  const em = orm.em.fork();
  for (let i = 0; i < 99; i++)
    em.persist(
      Object.assign(new Listing(), listingInput, {
        propertyId: canonical._id,
        publisherId: owner.id,
        ...propertySnapshot(canonical)
      })
    );
  await em.flush();
  const create = () =>
    owner.request('listings', 'POST', {
      ...listingInput,
      propertyId: p.id,
      expectedPropertyVersion: 1
    });
  const responses = await Promise.all([create(), create()]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  expect((await create()).status).toBe(409);
  expect(await orm.em.fork().count(Listing, { propertyId: canonical._id })).toBe(100);
});

it('rejects expired, stale-approved, held, inactive, unverified and media-incomplete public eligibility', async () => {
  const l = await listing();
  await state(l, 'published');
  const listingRecord = await stored(l.id);
  const user = await orm.em.fork().findOneOrFail(User, owner.id);
  const policy = app.get(ListingsPolicy);
  expect(await policy.publiclyEligible(listingRecord, user)).toBe(false);
  vi.spyOn(media, 'ready').mockResolvedValue(true);
  expect(await policy.publiclyEligible(listingRecord, user)).toBe(true);
  expect(
    await policy.publiclyEligible(
      Object.assign(new Listing(), listingRecord, {
        version: 2,
        approvedVersion: 2,
        submittedVersion: 1
      }),
      user
    )
  ).toBe(true);
  for (const invalid of [
    { expiresAt: new Date(0) },
    { expiresAt: new Date() },
    { approvedVersion: 0 },
    { submittedVersion: null },
    { submittedVersion: listingRecord.version + 1 },
    { publishedAt: new Date(Date.now() + 60000) },
    { publishedAt: null },
    { moderationHold: true },
    { deletedAt: new Date() },
    { reviewedById: owner.id },
    { reviewedById: null },
    { status: 'paused' },
    { status: 'draft' }
  ])
    expect(
      await policy.publiclyEligible(Object.assign(new Listing(), listingRecord, invalid), user)
    ).toBe(false);
  for (const invalid of [
    { status: 'suspended' },
    { status: 'deleted' },
    { deletedAt: new Date() },
    { emailVerifiedAt: null }
  ])
    expect(
      await policy.publiclyEligible(listingRecord, Object.assign(new User(), user, invalid))
    ).toBe(false);
  expect(await policy.publiclyEligible(listingRecord, accounts[1]!)).toBe(false);
  expect(await policy.publiclyEligible(listingRecord, null)).toBe(false);
});

it('rolls back listing content, property fences and account fences when post-write work fails', async () => {
  const l = await listing();
  const em = orm.em.fork();
  const beforeProperty = await em.findOneOrFail(Property, new ObjectId(l.propertyId));
  const beforeOwner = await em.findOneOrFail(User, owner.id);
  vi.spyOn(media, 'ready').mockRejectedValueOnce(new Error('Synthetic post-write failure'));
  const response = await owner.request(`listings/${l.id}`, 'PATCH', {
    ...listingInput,
    title: 'Should never persist',
    expectedVersion: 1
  });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('Synthetic post-write failure');
  expect(await read(l.id)).toMatchObject({ title: listingInput.title, version: 1 });
  const after = orm.em.fork();
  expect((await after.findOneOrFail(Property, beforeProperty._id)).updatedAt).toEqual(
    beforeProperty.updatedAt
  );
  expect((await after.findOneOrFail(User, owner.id)).version).toBe(beforeOwner.version);
});

it('rolls back canonical content and every snapshot if the property transaction fails after updates', async () => {
  const p = await property();
  const l = await listing(owner, p);
  await state(l, 'published');
  const snapshots = app.get(PropertySnapshots);
  const update = snapshots.updateInTransaction.bind(snapshots);
  vi.spyOn(snapshots, 'updateInTransaction').mockImplementationOnce(async (...args) => {
    await update(...args);
    throw new Error('Synthetic canonical failure');
  });
  const response = await owner.request(`properties/${p.id}`, 'PATCH', {
    ...propertyInput,
    details: { ...propertyInput.details, areaM2: 99 },
    expectedVersion: 1
  });
  expect(response.status).toBe(500);
  expect((await owner.request(`properties/${p.id}`)).status).toBe(200);
  expect(await read(l.id)).toMatchObject({
    status: 'published',
    version: 1,
    property: { version: 1, details: { areaM2: 45 } }
  });
  expect(await snapshots.drift(new ObjectId(p.id))).toEqual([]);
});

it('serves OpenAPI contracts with owner-only security, bounded schemas and no owner publication action', async () => {
  const response = await owner.request('openapi.json');
  expect(response.status).toBe(200);
  const document = await response.json();
  expect(document.openapi).toBe('3.1.0');
  expect(document.paths['/properties'].post.security).toEqual([{ bearerAuth: [] }]);
  expect(document.paths['/listings/{id}/submit'].post.responses['409']).toBeDefined();
  expect(document.paths['/listings/{id}/approve']).toBeUndefined();
  expect(document.components.schemas.CreateListing.additionalProperties).toBe(false);
  expect(document.components.schemas.CreateListing.properties).not.toHaveProperty('status');
});
