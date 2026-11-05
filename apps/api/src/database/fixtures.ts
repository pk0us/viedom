import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { User, Property, Listing } from './entities.js';
import { listingStates } from './domain.js';
import { approximateLocation } from './domain.js';
import { propertySnapshot } from './snapshots.js';

export const fixtureNamespace = 'viedom.phase04.v1';
const id = (n: number) => new ObjectId(`040000000000000000${n.toString(16).padStart(6, '0')}`);

/** Synthetic .invalid identities have no password hash and cannot be used to sign in. */
export function fixtures() {
  const users = ['owner', 'other-owner', 'reviewer', 'suspended-owner'].map((name, i) =>
    Object.assign(new User(), {
      _id: id(i + 1),
      fixtureKey: `${fixtureNamespace}.${name}`,
      email: `${name}@phase04.invalid`,
      firstName: 'Synthetic',
      lastName: name,
      role: i === 2 ? ('ADMIN' as const) : ('USER' as const),
      status: i === 3 ? ('suspended' as const) : ('active' as const),
      emailVerifiedAt: new Date('2026-01-01T00:00:00Z')
    })
  );
  const states = [...listingStates, 'published', 'published', 'published'] as const;
  const properties = states.map((_, i) => {
    const privateLocation = {
      type: 'Point' as const,
      coordinates: [22.94 + i * 0.001, 40.64 + i * 0.001] as [number, number]
    };
    return Object.assign(new Property(), {
      _id: id(100 + i),
      fixtureKey: `${fixtureNamespace}.property.${i}`,
      ownerId: users[i === 8 ? 3 : i === 1 ? 1 : 0]!._id,
      type: i % 2 ? ('apartment' as const) : ('studio' as const),
      details: {
        areaM2: 45 + i,
        bedrooms: i % 3,
        bathrooms: 1,
        floor: i % 4,
        yearBuilt: null,
        amenities: []
      },
      address: {
        countryCode: 'GR' as const,
        city: 'Thessaloniki',
        neighborhood: 'Synthetic district',
        street: `PRIVATE SYNTHETIC STREET ${i}`
      },
      privateLocation,
      publicLocation: approximateLocation(privateLocation)
    });
  });
  const listings = states.map((status, i) =>
    Object.assign(new Listing(), {
      _id: id(200 + i),
      fixtureKey: `${fixtureNamespace}.listing.${i}`,
      propertyId: properties[i]!._id,
      publisherId: properties[i]!.ownerId,
      transactionType: i % 2 ? ('sale' as const) : ('rent' as const),
      title: `Synthetic ${status} fixture ${i}`,
      slug: `synthetic-fixture-${i}`,
      description: 'Synthetic development fixture. No real property or contact information.',
      priceMinor: i % 2 ? 12_000_000 : 65_000,
      status,
      submittedVersion: ['pending_review', 'published', 'paused'].includes(status) ? 1 : null,
      approvedVersion: ['published', 'paused'].includes(status) ? 1 : null,
      reviewedById: ['published', 'paused', 'rejected'].includes(status) ? users[2]!._id : null,
      publishedAt: ['published', 'paused'].includes(status)
        ? new Date('2026-01-01T00:00:00Z')
        : null,
      expiresAt: i === 6 ? new Date('2020-01-01T00:00:00Z') : null,
      moderationHold: i === 7,
      ...propertySnapshot(properties[i]!)
    })
  );
  return { users, properties, listings };
}

/** Insert absent fixture IDs atomically; preserve existing fixtures and all unrelated records. */
export async function seed(orm: MikroORM, data = fixtures()): Promise<number> {
  return orm.em.fork().transactional(async (em) => {
    let inserted = 0;
    for (const entity of [...data.users, ...data.properties, ...data.listings]) {
      const existing = await em.findOne(entity.constructor as typeof User, { _id: entity._id });
      if (existing) {
        if (existing.fixtureKey !== entity.fixtureKey)
          throw new Error('Fixture ID collision; existing data preserved.');
      } else {
        em.persist(entity);
        inserted++;
      }
    }
    await em.flush();
    return inserted;
  });
}
