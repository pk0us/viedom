import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { wrap } from '@mikro-orm/core';
import { loadConfig } from '../../../scripts/config.mjs';
import { localTarget } from '../src/database/local-target.js';
import { initializeOrm, ormOptions } from '../src/database/orm-options.js';
import { provision } from '../src/database/provision.js';
import { fixtures, seed } from '../src/database/fixtures.js';
import { Listing, Property, User } from '../src/database/entities.js';
import { PersistenceConflict, PropertySnapshots } from '../src/database/snapshots.js';
import { approximateLocation } from '../src/database/domain.js';
import { publicListingSummary } from '../src/database/public-projection.js';

let orm: MikroORM;
let snapshots: PropertySnapshots;
const data = fixtures();
const ids = new Map<string, ObjectId>();
const newId = (old: ObjectId) => {
  const key = old.toHexString();
  if (!ids.has(key)) ids.set(key, new ObjectId());
  return ids.get(key)!;
};
const run = new ObjectId().toHexString();
// Each run owns fresh document IDs. No collection/database/volume reset is used.
for (const user of data.users) {
  user._id = newId(user._id);
  user.fixtureKey = `${run}.${user.fixtureKey}`;
  user.email = `${run}.${user.email}`;
}
for (const property of data.properties) {
  property._id = newId(property._id);
  property.ownerId = newId(property.ownerId);
  property.fixtureKey = `${run}.${property.fixtureKey}`;
}
for (const listing of data.listings) {
  listing._id = newId(listing._id);
  listing.propertyId = newId(listing.propertyId);
  listing.publisherId = newId(listing.publisherId);
  if (listing.reviewedById) listing.reviewedById = newId(listing.reviewedById);
  listing.fixtureKey = `${run}.${listing.fixtureKey}`;
}
const extraIds: ObjectId[] = [];
const collision = fixtures();
for (const user of collision.users) {
  user._id = new ObjectId();
  extraIds.push(user._id);
  user.email = `${run}.collision.${user.email}`;
  user.fixtureKey = `${run}.collision.${user.fixtureKey}`;
}

beforeAll(async () => {
  const target = localTarget(loadConfig(), true);
  orm = await initializeOrm(ormOptions(target.uri, target.dbName));
  snapshots = new PropertySnapshots(orm);
  await provision(orm);
});

afterAll(async () => {
  if (!orm) return;
  try {
    const db = orm.em.getConnection().getDb();
    await db.collection('listings').deleteMany({ _id: { $in: data.listings.map((r) => r._id) } });
    await db
      .collection('properties')
      .deleteMany({ _id: { $in: data.properties.map((r) => r._id) } });
    await db
      .collection('users')
      .deleteMany({ _id: { $in: [...data.users.map((r) => r._id), ...extraIds] } });
  } finally {
    await orm.close(true);
  }
});

it('provisions twice, seeds twice, and preserves edited fixture and unrelated data', async () => {
  await provision(orm);
  expect(await seed(orm, data)).toBe(22);
  expect(await seed(orm, data)).toBe(0);
  const em = orm.em.fork();
  const owner = await em.findOneOrFail(User, { _id: data.users[0]!._id });
  owner.firstName = 'Preserved';
  await em.flush();
  const unrelated = Object.assign(new User(), {
    email: `${run}.unrelated@example.invalid`,
    firstName: 'Unrelated',
    lastName: 'Fixture'
  });
  extraIds.push(unrelated._id);
  em.persist(unrelated);
  await em.flush();
  expect(await seed(orm, data)).toBe(0);
  expect((await orm.em.fork().findOneOrFail(User, owner._id)).firstName).toBe('Preserved');
  expect(await orm.em.fork().count(User, { _id: unrelated._id })).toBe(1);
  const db = orm.em.getConnection().getDb();
  expect(
    (await db.collection('users').indexes()).some(
      (index) => index.name === 'email_normalized_unique' && index.unique
    )
  ).toBe(true);
  expect(
    (await db.collection('listings').indexes()).some(
      (index) => index.key['publicLocation'] === '2dsphere'
    )
  ).toBe(true);
});

it('normalizes through MikroORM and rejects duplicate email at the unique database index', async () => {
  const em = orm.em.fork();
  const duplicate = Object.assign(new User(), {
    email: `  ${data.users[0]!.email.toUpperCase()}  `,
    firstName: 'Duplicate',
    lastName: 'Fixture'
  });
  extraIds.push(duplicate._id);
  em.persist(duplicate);
  await expect(em.flush()).rejects.toMatchObject({ code: 11000 });
  expect(duplicate.email).toBe(data.users[0]!.email);
});

it('refuses fixture ID collisions and rolls the seed transaction back', async () => {
  const fresh = collision.users[0]!._id;
  collision.users[1]!._id = data.users[1]!._id;
  await expect(seed(orm, collision)).rejects.toThrow('collision');
  expect(await orm.em.fork().count(User, { _id: fresh })).toBe(0);
});

it('rejects invalid native writes including latitude, operator-shaped fields, price and unnormalized email', async () => {
  const db = orm.em.getConnection().getDb();
  const propertyId = data.properties[0]!._id;
  for (const invalid of [
    { privateLocation: { type: 'Point', coordinates: [22, 120] } },
    { privateLocation: { type: 'Point', coordinates: [181, 40] } },
    { 'details.bedrooms': -1 },
    { 'details.areaM2': Infinity },
    { 'details.floor': 0.5 },
    { 'address.city': { $ne: null } }
  ])
    await expect(
      db.collection('properties').updateOne({ _id: propertyId }, { $set: invalid })
    ).rejects.toMatchObject({ code: 121 });
  for (const invalid of [
    { priceMinor: 1.5 },
    { priceMinor: NaN },
    { priceMinor: 0 },
    { currency: 'USD' },
    { privateLocation: { type: 'Point', coordinates: [22, 40] } }
  ]) {
    await expect(
      db.collection('listings').updateOne({ _id: data.listings[0]!._id }, { $set: invalid })
    ).rejects.toMatchObject({ code: 121 });
  }
  await expect(
    db
      .collection('users')
      .updateOne({ _id: data.users[0]!._id }, { $set: { email: 'UPPER@example.com' } })
  ).rejects.toMatchObject({ code: 121 });
});

it('round-trips ObjectIds/GeoJSON, queries the public geospatial index, and excludes private serialized fields', async () => {
  const em = orm.em.fork();
  const property = await em.findOneOrFail(Property, data.properties[0]!._id);
  expect(property.ownerId).toBeInstanceOf(ObjectId);
  expect(property.privateLocation.coordinates).toEqual([22.94, 40.64]);
  expect(property.publicLocation).toEqual(approximateLocation(property.privateLocation));
  const hidden = wrap(property).toObject();
  expect(hidden).not.toHaveProperty('privateLocation');
  expect(hidden).not.toHaveProperty('address');
  const listing = await em.findOneOrFail(Listing, data.listings[3]!._id);
  expect(listing.reviewedById?.equals(listing.publisherId)).toBe(false);
  const json = JSON.stringify(publicListingSummary(listing));
  expect(json).not.toContain('PRIVATE SYNTHETIC');
  expect(json).not.toContain('publisherId');
  const found = await orm.em
    .getConnection()
    .getDb()
    .collection('listings')
    .find({
      _id: { $in: data.listings.map((r) => r._id) },
      publicLocation: {
        $geoWithin: {
          $geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [22.9, 40.6],
                [23, 40.6],
                [23, 40.7],
                [22.9, 40.7],
                [22.9, 40.6]
              ]
            ]
          }
        }
      }
    })
    .hint('public_location_geo')
    .toArray();
  expect(found).toHaveLength(9);
});

it('updates every affected snapshot atomically, invalidates review, and rejects stale/cross-owner changes', async () => {
  const p = data.properties[3]!;
  // Two advertisements share this canonical property.
  await orm.em.fork().nativeUpdate(Listing, data.listings[4]!._id, { propertyId: p._id });
  const content = {
    ...p,
    details: { ...p.details, areaM2: 88 },
    privateLocation: { type: 'Point' as const, coordinates: [22.96, 40.66] as [number, number] }
  };
  await expect(snapshots.update(p._id, data.users[1]!._id, 1, content)).rejects.toBeInstanceOf(
    PersistenceConflict
  );
  await snapshots.update(p._id, p.ownerId, 1, content);
  expect(await snapshots.drift(p._id)).toEqual([]);
  const saved = await orm.em.fork().findOneOrFail(Property, p._id);
  expect(saved.version).toBe(2);
  expect(saved.details.areaM2).toBe(88);
  const listings = await orm.em.fork().find(Listing, { propertyId: p._id });
  expect(listings).toHaveLength(2);
  for (const listing of listings) {
    expect(listing.status).toBe('draft');
    expect(listing.propertyVersion).toBe(2);
    expect(listing.version).toBe(2);
    expect(listing.approvedVersion).toBeNull();
    expect(listing.submittedVersion).toBeNull();
    expect(listing.publishedAt).toBeNull();
    expect(listing.publicLocation).toEqual(saved.publicLocation);
  }
  await expect(snapshots.update(p._id, p.ownerId, 1, content)).rejects.toBeInstanceOf(
    PersistenceConflict
  );
});

it('allows only one of two concurrent expected-version updates to commit', async () => {
  const p = data.properties[2]!;
  const results = await Promise.allSettled([
    snapshots.update(p._id, p.ownerId, 1, { ...p, details: { ...p.details, areaM2: 70 } }),
    snapshots.update(p._id, p.ownerId, 1, { ...p, details: { ...p.details, areaM2: 80 } })
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const saved = await orm.em.fork().findOneOrFail(Property, p._id);
  expect(saved.version).toBe(2);
  expect([70, 80]).toContain(saved.details.areaM2);
  expect(await snapshots.drift(p._id)).toEqual([]);
  const listing = await orm.em.fork().findOneOrFail(Listing, data.listings[2]!._id);
  expect(listing.version).toBe(2);
  expect(listing.status).toBe('draft');
});

it('keeps archived advertisements terminal while updating their snapshot', async () => {
  const p = data.properties[5]!;
  await snapshots.update(p._id, p.ownerId, 1, { ...p, details: { ...p.details, areaM2: 66 } });
  const listing = await orm.em.fork().findOneOrFail(Listing, data.listings[5]!._id);
  expect(listing.status).toBe('archived');
  expect(listing.areaM2).toBe(66);
  expect(await snapshots.drift(p._id)).toEqual([]);
});

it('rolls canonical and listing writes back on failure, then detects and repairs drift without clearing holds', async () => {
  const p = data.properties[7]!;
  const em = orm.em.fork();
  const original = await em.findOneOrFail(Property, p._id);
  let abort = true;
  orm.em.getEventManager().registerSubscriber({
    beforeTransactionCommit() {
      if (abort) {
        abort = false;
        throw new Error('Injected transaction failure');
      }
    }
  });
  await expect(
    snapshots.update(p._id, p.ownerId, 1, { ...p, details: { ...p.details, areaM2: 99 } })
  ).rejects.toThrow('Injected');
  const unchanged = await orm.em.fork().findOneOrFail(Property, p._id);
  expect(unchanged.version).toBe(original.version);
  expect(unchanged.details.areaM2).toBe(original.details.areaM2);
  const listing = await orm.em.fork().findOneOrFail(Listing, data.listings[7]!._id);
  expect(listing.status).toBe('published');
  expect(listing.approvedVersion).toBe(1);
  await orm.em.fork().nativeUpdate(Listing, listing._id, { areaM2: 999 });
  expect(await snapshots.drift(p._id)).toEqual([listing._id.toHexString()]);
  await snapshots.repair(p._id, p.ownerId, 1);
  expect(await snapshots.drift(p._id)).toEqual([]);
  const repaired = await orm.em.fork().findOneOrFail(Listing, listing._id);
  expect(repaired.status).toBe('draft');
  expect(repaired.moderationHold).toBe(true);
});
