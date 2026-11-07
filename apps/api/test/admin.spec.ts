import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { EntityManager, MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { EntitySchema, MikroORM as CoreMikroORM } from '@mikro-orm/core';
import type {
  AdminListingDetail,
  AdminListingsResponse,
  OwnerListingDetail,
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
import { provision, validators } from '../src/database/provision.js';
import {
  adminProvisioningValidators,
  FirstAdminGrant,
  provisionFirstAdmin
} from '../src/database/admin-provision.js';
import { Listing, Property, User } from '../src/database/entities.js';
import { PropertiesModule } from '../src/properties/properties.module.js';
import { ListingsModule } from '../src/listings/listings.module.js';
import { ListingsPolicy } from '../src/listings/listings.policy.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { ModerationDecision } from '../src/admin/moderation.entities.js';
import { MediaAsset, MediaGallery } from '../src/media/media.entities.js';
import { MediaStorage } from '../src/media/storage.js';

const config = loadConfig();
const run = new ObjectId().toHexString();
const accounts: User[] = [];
let orm: MikroORM;
let app: INestApplication;
let store: AuthStore;
let base: string;
let owner: Client;
let admin: Client;
let secondAdmin: Client;

const propertyInput: PropertyContent = {
  type: 'studio',
  details: { areaM2: 45, bedrooms: 0, bathrooms: 1, floor: 0, yearBuilt: null, amenities: [] },
  address: {
    countryCode: 'GR',
    city: 'Thessaloniki',
    neighborhood: 'Synthetic',
    street: 'PRIVATE MODERATION STREET'
  },
  privateLocation: { type: 'Point', coordinates: [22.9444, 40.6401] }
};
const listingInput = {
  transactionType: 'rent',
  title: 'Synthetic moderation studio',
  description: 'Synthetic review content without any real personal or contact information.',
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

async function account(role: 'USER' | 'ADMIN' = 'USER') {
  const user = Object.assign(new User(), {
    email: `${run}.${accounts.length}@example.invalid`,
    firstName: 'Synthetic',
    lastName: 'Moderator',
    emailVerifiedAt: new Date(),
    role
  });
  accounts.push(user);
  const em = orm.em.fork();
  em.persist(user);
  await em.flush();
  const session = await store.create({ user }, config.auth.refreshTtl);
  return new Client(user._id, (await app.get(AuthService).response(session)).accessToken);
}

async function draft(client = owner) {
  const createdProperty = await client.request('properties', 'POST', propertyInput);
  expect(createdProperty.status).toBe(201);
  const property: OwnerProperty = await createdProperty.json();
  const created = await client.request('listings', 'POST', {
    ...listingInput,
    propertyId: property.id,
    expectedPropertyVersion: property.version
  });
  expect(created.status).toBe(201);
  const listing: OwnerListingDetail = await created.json();
  const asset = Object.assign(new MediaAsset(), {
    listingId: new ObjectId(listing.id),
    ownerId: client.id,
    state: 'ready',
    originalKey: `synthetic-admin/${run}/${new ObjectId()}`,
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
    listingId: asset.listingId,
    ownerId: client.id,
    mediaIds: [asset._id.toHexString()],
    coverMediaId: asset._id.toHexString()
  });
  const em = orm.em.fork();
  em.persist(asset);
  em.persist(gallery);
  await em.flush();
  return { listing, asset, gallery };
}

async function pending(client = owner) {
  const fixture = await draft(client);
  const response = await client.request(`listings/${fixture.listing.id}/submit`, 'POST', {
    expectedVersion: fixture.listing.version
  });
  expect(response.status).toBe(200);
  return { ...fixture, listing: (await response.json()) as OwnerListingDetail };
}

function decide(
  listing: OwnerListingDetail,
  decision: 'approve' | 'reject',
  client = admin,
  extra = {}
) {
  return client.request(`admin/listings/${listing.id}/${decision}`, 'POST', {
    expectedVersion: listing.version,
    ...(decision === 'reject' ? { reason: 'Improve the description before resubmitting.' } : {}),
    ...extra
  });
}

beforeAll(async () => {
  const target = localTarget(config, true);
  orm = await initializeOrm(ormOptions(target.uri, target.dbName));
  await provision(orm);
  const module = await Test.createTestingModule({
    imports: [AuthModule, PropertiesModule, ListingsModule, AdminModule]
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
  app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );
  app.useGlobalFilters(new ApiErrorFilter());
  await app.listen(0, '127.0.0.1');
  await app.get(AuthActions).onModuleDestroy();
  base = await app.getUrl();
  store = app.get(AuthStore);
  owner = await account();
  admin = await account('ADMIN');
  secondAdmin = await account('ADMIN');
});

afterAll(async () => {
  if (orm) {
    const ids = accounts.map((user) => user._id);
    const db = orm.em.getConnection().getDb();
    await db.collection('moderation_decisions').deleteMany({ publisherId: { $in: ids } });
    await db.collection('media_assets').deleteMany({ ownerId: { $in: ids } });
    await db.collection('media_galleries').deleteMany({ ownerId: { $in: ids } });
    await db.collection('listings').deleteMany({ publisherId: { $in: ids } });
    await db.collection('properties').deleteMany({ ownerId: { $in: ids } });
    if (store) {
      const sessions = await store.sessions.find({ userId: { $in: ids } }).toArray();
      await store.tokens.deleteMany({ sessionId: { $in: sessions.map((record) => record._id) } });
      await store.sessions.deleteMany({ userId: { $in: ids } });
      await store.users.deleteMany({ _id: { $in: ids } });
    }
  }
  await app?.close();
  await orm?.close(true);
});

afterEach(() => vi.restoreAllMocks());

it('requires live admin authority on queue, details, media and both decisions', async () => {
  const { listing, asset } = await pending();
  const anonymous = new Client(new ObjectId(), '');
  for (const [client, expected] of [
    [anonymous, 401],
    [owner, 403]
  ] as const) {
    for (const [path, method, body] of [
      ['admin/listings/pending', 'GET', undefined],
      [`admin/listings/${listing.id}`, 'GET', undefined],
      [`admin/listings/${listing.id}/media/${asset._id}/large`, 'GET', undefined],
      [`admin/listings/${listing.id}/approve`, 'POST', { expectedVersion: listing.version }],
      [
        `admin/listings/${listing.id}/reject`,
        'POST',
        { expectedVersion: listing.version, reason: 'Reason' }
      ]
    ] as const) {
      const response = await client.request(path, method, body);
      expect(response.status).toBe(expected);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).not.toContain(propertyInput.address.street);
    }
  }
  const revoked = await account('ADMIN');
  await store.users.updateOne({ _id: revoked.id }, { $set: { role: 'USER' } });
  expect((await decide(listing, 'approve', revoked)).status).toBe(403);
  const suspended = await account('ADMIN');
  await store.users.updateOne({ _id: suspended.id }, { $set: { status: 'suspended' } });
  expect((await suspended.request('admin/listings/pending')).status).toBe(401);
  const expired = await account('ADMIN');
  await store.sessions.updateMany({ userId: expired.id }, { $set: { revokedAt: new Date() } });
  expect((await expired.request('admin/listings/pending')).status).toBe(401);
  expect((await admin.request(`me/listings/${listing.id}`)).status).toBe(404);
  const self = await pending(admin);
  expect((await decide(self.listing, 'approve')).status).toBe(403);
  expect((await decide(self.listing, 'reject')).status).toBe(403);
});

it('paginates pending submissions deterministically and projects explicit review fields', async () => {
  const fixtures = [await pending(), await pending(), await pending()];
  const expected = new Set(fixtures.map(({ listing }) => listing.id));
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await admin.request(
      `admin/listings/pending?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const page: AdminListingsResponse = await response.json();
    expect(page.items.length).toBeLessThanOrEqual(2);
    for (const item of page.items) {
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
      expect(item.status).toBe('pending_review');
    }
    cursor = page.nextCursor;
  } while (cursor);
  for (const id of expected) expect(seen.has(id)).toBe(true);
  const response = await admin.request(`admin/listings/${fixtures[0]!.listing.id}`);
  expect(response.status).toBe(200);
  const review: AdminListingDetail = await response.json();
  expect(review.listing.property.address.street).toBe(propertyInput.address.street);
  expect(review.publisher).toMatchObject({
    id: owner.id.toHexString(),
    active: true,
    emailVerified: true
  });
  expect(review.canDecide).toBe(true);
  for (const field of ['passwordHash', 'originalKey', 'processingKeys', 'leaseToken', 'fixtureKey'])
    expect(JSON.stringify(review)).not.toContain(field);
});

it('validates pagination, reason, version and privileged input fields', async () => {
  const { listing } = await pending();
  for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'cursor=garbage', 'unknown=true'])
    expect((await admin.request(`admin/listings/pending?${query}`)).status).toBe(400);
  for (const reason of ['', '  ', 'x'.repeat(2001), { $ne: '' }, null])
    expect((await decide(listing, 'reject', admin, { reason })).status).toBe(400);
  for (const extra of [
    { expectedVersion: 0 },
    { expectedVersion: '2' },
    { status: 'published' },
    { reviewerId: owner.id.toHexString() }
  ])
    expect((await decide(listing, 'approve', admin, extra)).status).toBe(400);
  expect((await admin.request('admin/listings/not-an-id')).status).toBe(400);
  expect((await admin.request(`admin/listings/${new ObjectId()}`)).status).toBe(404);
});

it('approves the exact submitted version with one durable audit event and publication eligibility', async () => {
  const { listing } = await pending();
  const response = await decide(listing, 'approve');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: listing.id,
    version: listing.version + 1,
    status: 'published',
    rejectionReason: null
  });
  const stored = await orm.em.fork().findOneOrFail(Listing, new ObjectId(listing.id));
  expect(stored.approvedVersion).toBe(stored.version);
  expect(stored.reviewedById).toEqual(admin.id);
  expect(stored.publishedAt).toBeInstanceOf(Date);
  expect(stored.expiresAt!.getTime() - stored.publishedAt!.getTime()).toBe(90 * 86_400_000);
  const publisher = await orm.em.fork().findOneOrFail(User, owner.id);
  expect(await app.get(ListingsPolicy).publiclyEligible(stored, publisher)).toBe(true);
  const events = await orm.em.fork().find(ModerationDecision, { listingId: stored._id });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    reviewerId: admin.id,
    publisherId: owner.id,
    decision: 'approved',
    reviewedVersion: listing.version,
    resultVersion: stored.version,
    reason: null
  });
  expect((await decide(listing, 'approve')).status).toBe(409);
  expect((await decide(listing, 'reject')).status).toBe(409);
});

it('rejects privately, returns a trimmed reason to its owner and preserves history after resubmission', async () => {
  const { listing } = await pending();
  const response = await decide(listing, 'reject', admin, {
    reason: '  Add a clearer description.  '
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: 'rejected',
    rejectionReason: 'Add a clearer description.'
  });
  const saved: OwnerListingDetail = await (await owner.request(`me/listings/${listing.id}`)).json();
  expect(saved.rejectionReason).toBe('Add a clearer description.');
  expect(saved.publishedAt).toBeNull();
  const stored = await orm.em.fork().findOneOrFail(Listing, new ObjectId(listing.id));
  expect(stored.approvedVersion).toBeNull();
  const publisher = await orm.em.fork().findOneOrFail(User, owner.id);
  expect(await app.get(ListingsPolicy).publiclyEligible(stored, publisher)).toBe(false);
  expect((await fetch(`${base}/api/listings/${listing.id}`)).status).toBe(404);
  const resubmitted = await owner.request(`listings/${listing.id}/submit`, 'POST', {
    expectedVersion: saved.version
  });
  expect(resubmitted.status).toBe(200);
  expect(await resubmitted.json()).toMatchObject({
    status: 'pending_review',
    rejectionReason: null
  });
  const review: AdminListingDetail = await (
    await admin.request(`admin/listings/${listing.id}`)
  ).json();
  expect(review.history).toHaveLength(1);
  expect(review.history[0]).toMatchObject({
    decision: 'rejected',
    reason: 'Add a clearer description.'
  });
});

it('serializes concurrent conflicting decisions into one result and one audit record', async () => {
  const { listing } = await pending();
  const results = await Promise.all([
    decide(listing, 'approve'),
    decide(listing, 'reject', secondAdmin)
  ]);
  expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
  const events = await orm.em
    .fork()
    .find(ModerationDecision, { listingId: new ObjectId(listing.id) });
  expect(events).toHaveLength(1);
  const stored = await orm.em.fork().findOneOrFail(Listing, new ObjectId(listing.id));
  expect(stored.version).toBe(listing.version + 1);
  expect(stored.status).toBe(events[0]!.decision === 'approved' ? 'published' : 'rejected');
});

it('keeps publication consistent when approval races canonical property or gallery changes', async () => {
  for (const mutation of ['property', 'media'] as const) {
    const { listing, asset } = await pending();
    const change =
      mutation === 'property'
        ? owner.request(`properties/${listing.propertyId}`, 'PATCH', {
            ...propertyInput,
            address: { ...propertyInput.address, city: 'Updated synthetic city' },
            expectedVersion: listing.propertyVersion
          })
        : owner.request(`listings/${listing.id}/media`, 'PATCH', {
            mediaIds: [asset._id.toHexString()],
            coverMediaId: asset._id.toHexString(),
            expectedVersion: listing.version
          });
    const [changed, approved] = await Promise.all([change, decide(listing, 'approve')]);
    expect([200, 409]).toContain(changed.status);
    expect([200, 409]).toContain(approved.status);
    expect([changed.status, approved.status]).toContain(200);
    const em = orm.em.fork();
    const stored = await em.findOneOrFail(Listing, new ObjectId(listing.id));
    const canonical = await em.findOneOrFail(Property, new ObjectId(listing.propertyId));
    expect(stored.propertyVersion).toBe(canonical.version);
    expect(stored.city).toBe(canonical.address.city);
    expect(stored.status).toBe(changed.status === 200 ? 'draft' : 'published');
    expect(stored.approvedVersion).toBe(stored.status === 'published' ? stored.version : null);
    expect(await em.count(ModerationDecision, { listingId: stored._id })).toBe(
      approved.status === 200 ? 1 : 0
    );
  }
});

it('rechecks administrative authority after reading a private image from storage', async () => {
  const { listing, asset } = await pending();
  for (const authority of ['role', 'session'] as const) {
    const client = await account('ADMIN');
    let entered = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(app.get(MediaStorage), 'read').mockImplementation(async () => {
      entered();
      await gate;
      return Buffer.from('PRIVATE SYNTHETIC IMAGE BYTES');
    });
    const response = client.request(`admin/listings/${listing.id}/media/${asset._id}/large`);
    try {
      await started;
      if (authority === 'role')
        await store.users.updateOne({ _id: client.id }, { $set: { role: 'USER' } });
      else
        await store.sessions.updateMany({ userId: client.id }, { $set: { revokedAt: new Date() } });
      release();
      const denied = await response;
      expect(denied.status).toBe(authority === 'role' ? 403 : 401);
      expect(denied.headers.get('cache-control')).toBe('no-store');
      expect(await denied.text()).not.toContain('PRIVATE SYNTHETIC IMAGE BYTES');
    } finally {
      release();
      await response;
      read.mockRestore();
    }
  }
});

it('rolls back a decision when its session is revoked after the final authority read and before commit', async () => {
  const { listing } = await pending();
  const client = await account('ADMIN');
  const current = store.current.bind(store);
  const flush = EntityManager.prototype.flush;
  let flushedDecision = false;
  let revoked = false;
  vi.spyOn(EntityManager.prototype, 'flush').mockImplementation(async function (
    this: EntityManager
  ) {
    const decision = [...this.getUnitOfWork().getPersistStack()].some(
      (entity) => entity instanceof ModerationDecision
    );
    await flush.call(this);
    if (decision) flushedDecision = true;
  });
  vi.spyOn(store, 'current').mockImplementation(async (userId, sessionId) => {
    const user = await current(userId, sessionId);
    if (flushedDecision && userId.equals(client.id)) {
      await store.sessions.updateOne({ _id: sessionId }, { $set: { revokedAt: new Date() } });
      revoked = true;
    }
    return user;
  });
  const response = await decide(listing, 'approve', client);
  expect(revoked).toBe(true);
  expect([401, 409]).toContain(response.status);
  const em = orm.em.fork();
  expect(await em.findOneOrFail(Listing, new ObjectId(listing.id))).toMatchObject({
    status: 'pending_review',
    version: listing.version,
    approvedVersion: null,
    publishedAt: null
  });
  expect(await em.count(ModerationDecision, { listingId: new ObjectId(listing.id) })).toBe(0);
});

it('allows rejection with owner feedback when a submitted photo no longer meets publication requirements', async () => {
  const { listing, asset } = await pending();
  await orm.em.fork().nativeUpdate(MediaAsset, asset._id, {
    state: 'failed',
    variants: null,
    errorCode: 'invalid_image'
  });
  const review: AdminListingDetail = await (
    await admin.request(`admin/listings/${listing.id}`)
  ).json();
  expect(review.canDecide).toBe(true);
  expect(review.canApprove).toBe(false);
  expect((await decide(listing, 'approve')).status).toBe(409);
  expect((await decide(listing, 'reject')).status).toBe(200);
  const ownerDetail: OwnerListingDetail = await (
    await owner.request(`me/listings/${listing.id}`)
  ).json();
  expect(ownerDetail).toMatchObject({
    status: 'rejected',
    rejectionReason: 'Improve the description before resubmitting.'
  });
  expect(
    await orm.em.fork().count(ModerationDecision, { listingId: new ObjectId(listing.id) })
  ).toBe(1);
});

it('allows rejection of pending submissions after their publisher is suspended or loses email verification', async () => {
  for (const eligibility of ['suspended', 'unverified'] as const) {
    const client = await account();
    const { listing } = await pending(client);
    await store.users.updateOne(
      { _id: client.id },
      {
        $set: eligibility === 'suspended' ? { status: 'suspended' } : { emailVerifiedAt: null }
      }
    );
    const response = await admin.request(`admin/listings/${listing.id}`);
    expect(response.status).toBe(200);
    const review: AdminListingDetail = await response.json();
    expect(review.canDecide).toBe(true);
    expect(review.canApprove).toBe(false);
    expect((await decide(listing, 'approve')).status).toBe(409);
    expect((await decide(listing, 'reject')).status).toBe(200);
    const em = orm.em.fork();
    expect(await em.findOneOrFail(Listing, new ObjectId(listing.id))).toMatchObject({
      status: 'rejected',
      approvedVersion: null,
      publishedAt: null
    });
    const history = await em.find(ModerationDecision, { listingId: new ObjectId(listing.id) });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      decision: 'rejected',
      reason: 'Improve the description before resubmitting.'
    });
    await store.users.updateOne(
      { _id: client.id },
      { $set: { status: 'active', emailVerifiedAt: new Date() } }
    );
    const ownerDetail: OwnerListingDetail = await (
      await client.request(`me/listings/${listing.id}`)
    ).json();
    expect(ownerDetail.rejectionReason).toBe('Improve the description before resubmitting.');
  }
});

it('withdraws reviewed publication and historical rejection feedback after owner edits', async () => {
  for (const decision of ['approve', 'reject'] as const) {
    const { listing } = await pending();
    expect((await decide(listing, decision)).status).toBe(200);
    const saved: OwnerListingDetail = await (
      await owner.request(`me/listings/${listing.id}`)
    ).json();
    const updated = await owner.request(`listings/${listing.id}`, 'PATCH', {
      ...listingInput,
      title: 'Edited after an administrative decision',
      expectedVersion: saved.version
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ status: 'draft', rejectionReason: null });
    const stored = await orm.em.fork().findOneOrFail(Listing, new ObjectId(listing.id));
    expect(stored).toMatchObject({ approvedVersion: null, reviewedById: null, publishedAt: null });
    expect(await orm.em.fork().count(ModerationDecision, { listingId: stored._id })).toBe(1);
  }
});

it('rolls back publication and account fences when recording its audit event fails', async () => {
  const { listing } = await pending();
  const before = orm.em.fork();
  const publisher = await before.findOneOrFail(User, owner.id);
  const moderator = await before.findOneOrFail(User, admin.id);
  const property = await before.findOneOrFail(Property, new ObjectId(listing.propertyId));
  const flush = EntityManager.prototype.flush;
  vi.spyOn(EntityManager.prototype, 'flush').mockImplementation(async function (
    this: EntityManager
  ) {
    if (
      [...this.getUnitOfWork().getPersistStack()].some(
        (entity) => entity instanceof ModerationDecision
      )
    )
      throw new Error('Synthetic moderation audit failure');
    return flush.call(this);
  });
  const response = await decide(listing, 'approve');
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('Synthetic moderation audit failure');
  const after = orm.em.fork();
  expect(await after.findOneOrFail(Listing, new ObjectId(listing.id))).toMatchObject({
    status: 'pending_review',
    version: listing.version,
    publishedAt: null,
    approvedVersion: null
  });
  expect((await after.findOneOrFail(User, owner.id)).version).toBe(publisher.version);
  expect((await after.findOneOrFail(User, admin.id)).version).toBe(moderator.version);
  expect((await after.findOneOrFail(Property, property._id)).updatedAt).toEqual(property.updatedAt);
  expect(await after.count(ModerationDecision, { listingId: new ObjectId(listing.id) })).toBe(0);
});

it('rejects stale content and ineligible owners or media without recording a decision', async () => {
  const changed = await pending();
  expect(
    (
      await owner.request(`listings/${changed.listing.id}`, 'PATCH', {
        ...listingInput,
        title: 'Changed after review opened',
        expectedVersion: changed.listing.version
      })
    ).status
  ).toBe(200);
  expect((await decide(changed.listing, 'approve')).status).toBe(409);
  for (const invalid of [
    'media',
    'hold',
    'unverified',
    'suspended',
    'expired',
    'canonical'
  ] as const) {
    const client = await account();
    const fixture = await pending(client);
    const em = orm.em.fork();
    if (invalid === 'media')
      await em.nativeUpdate(MediaAsset, fixture.asset._id, {
        state: 'failed',
        variants: null,
        errorCode: 'invalid_image'
      });
    if (invalid === 'hold')
      await em.nativeUpdate(Listing, new ObjectId(fixture.listing.id), { moderationHold: true });
    if (invalid === 'unverified') await em.nativeUpdate(User, client.id, { emailVerifiedAt: null });
    if (invalid === 'suspended') await em.nativeUpdate(User, client.id, { status: 'suspended' });
    if (invalid === 'expired')
      await em.nativeUpdate(Listing, new ObjectId(fixture.listing.id), {
        expiresAt: new Date(Date.now() - 60_000)
      });
    if (invalid === 'canonical')
      await em.nativeUpdate(Property, new ObjectId(fixture.listing.propertyId), {
        version: fixture.listing.propertyVersion + 1
      });
    expect((await decide(fixture.listing, 'approve')).status).toBe(409);
    expect(
      await em.count(ModerationDecision, { listingId: new ObjectId(fixture.listing.id) })
    ).toBe(0);
  }
});

async function isolatedProvisioning(
  work: (isolated: MikroORM, users: User[]) => Promise<void>
): Promise<void> {
  const suffix = new ObjectId().toHexString();
  const usersCollection = `qa_admin_users_${suffix}`;
  const grantsCollection = `qa_admin_grants_${suffix}`;
  const userSchema = EntitySchema.fromMetadata<User>(orm.getMetadata().get<User>(User));
  userSchema.meta.tableName = usersCollection;
  userSchema.meta.root = userSchema.meta;
  const grantSchema = EntitySchema.fromMetadata<FirstAdminGrant>(
    orm.getMetadata().get<FirstAdminGrant>(FirstAdminGrant)
  );
  grantSchema.meta.tableName = grantsCollection;
  grantSchema.meta.root = grantSchema.meta;
  const target = localTarget(config, true);
  const isolated = await initializeOrm({
    ...ormOptions(target.uri, target.dbName),
    entities: [userSchema, grantSchema]
  });
  const db = isolated.em.getConnection().getDb();
  let createdUsers = false;
  let createdGrants = false;
  try {
    await db.createCollection(usersCollection, {
      validator: validators.users,
      validationLevel: 'strict',
      validationAction: 'error'
    });
    createdUsers = true;
    await db.createCollection(grantsCollection, {
      validator: adminProvisioningValidators.admin_provisioning,
      validationLevel: 'strict',
      validationAction: 'error'
    });
    createdGrants = true;
    await db.collection(usersCollection).createIndex({ email: 1 }, { unique: true });
    const users = [0, 1].map((index) =>
      Object.assign(new User(), {
        email: `${suffix}.${index}@example.invalid`,
        firstName: 'Synthetic',
        lastName: 'Provisioning',
        emailVerifiedAt: new Date()
      })
    );
    const em = isolated.em.fork();
    for (const user of users) em.persist(user);
    await em.flush();
    await work(isolated, users);
  } finally {
    if (createdGrants) await db.collection(grantsCollection).drop();
    if (createdUsers) await db.collection(usersCollection).drop();
    await isolated.close(true);
  }
}

it('grants the first administrator exactly once under concurrent eligible account requests', async () => {
  await isolatedProvisioning(async (isolated, users) => {
    const results = await Promise.allSettled(
      users.map((user) => provisionFirstAdmin(isolated, user._id.toHexString(), user.email))
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const em = isolated.em.fork();
    const grants = await em.find(FirstAdminGrant, {});
    const administrators = await em.find(User, { role: 'ADMIN' });
    expect(grants).toHaveLength(1);
    expect(administrators).toHaveLength(1);
    expect(grants[0]!.userId).toEqual(administrators[0]!._id);
    expect(grants[0]!.email).toBe(administrators[0]!.email);
    const other = users.find((user) => !user._id.equals(administrators[0]!._id))!;
    await expect(
      provisionFirstAdmin(isolated, other._id.toHexString(), other.email)
    ).rejects.toThrow();
    expect(await isolated.em.fork().count(FirstAdminGrant, {})).toBe(1);
  });
});

it('rolls back the first-administrator singleton when account promotion fails and permits a clean retry', async () => {
  await isolatedProvisioning(async (isolated, users) => {
    const user = users[0]!;
    const flush = EntityManager.prototype.flush;
    const failure = vi.spyOn(EntityManager.prototype, 'flush').mockImplementation(async function (
      this: EntityManager
    ) {
      const grant = [...this.getUnitOfWork().getPersistStack()].some(
        (entity) => entity instanceof FirstAdminGrant
      );
      await flush.call(this);
      if (grant) throw new Error('Synthetic provisioning failure after singleton insertion');
    });
    try {
      await expect(
        provisionFirstAdmin(isolated, user._id.toHexString(), user.email)
      ).rejects.toThrow('Synthetic provisioning failure');
    } finally {
      failure.mockRestore();
    }
    const em = isolated.em.fork();
    expect(await em.count(FirstAdminGrant, {})).toBe(0);
    expect(await em.findOneOrFail(User, user._id)).toMatchObject({ role: 'USER', version: 1 });
    await provisionFirstAdmin(isolated, user._id.toHexString(), user.email);
    const after = isolated.em.fork();
    expect(await after.count(FirstAdminGrant, {})).toBe(1);
    expect(await after.findOneOrFail(User, user._id)).toMatchObject({ role: 'ADMIN', version: 2 });
  });
});
