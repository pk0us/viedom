import { Injectable } from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { approximateLocation, number, requireValue, validateProperty } from './domain.js';
import type { PropertyContent } from './domain.js';
import { Listing, Property } from './entities.js';

export function propertySnapshot(property: Property) {
  return {
    propertyVersion: property.version,
    publicLocation: approximateLocation(property.privateLocation),
    propertyType: property.type,
    areaM2: property.details.areaM2,
    bedrooms: property.details.bedrooms,
    bathrooms: property.details.bathrooms,
    city: property.address.city,
    neighborhood: property.address.neighborhood
  };
}

export class PersistenceConflict extends Error {
  constructor() {
    super('Persistence version conflict.');
  }
}

/** Internal persistence primitive; Phase 08 adds authorization and lifecycle APIs. */
@Injectable()
export class PropertySnapshots {
  constructor(private readonly orm: MikroORM) {}

  async update(
    propertyId: ObjectId,
    ownerId: ObjectId,
    expectedVersion: number,
    content: PropertyContent
  ): Promise<void> {
    number(expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER - 1, true);
    validateProperty(content);
    // Copy only canonical content; caller objects never become query/update operators.
    const canonical = structuredClone({
      type: content.type,
      details: content.details,
      address: content.address,
      privateLocation: content.privateLocation,
      publicLocation: approximateLocation(content.privateLocation)
    });
    await this.orm.em.fork().transactional(async (em) => {
      const property = await em.findOne(Property, {
        _id: propertyId,
        ownerId,
        version: expectedVersion
      });
      if (!property) throw new PersistenceConflict();
      const listings = await em.find(Listing, { propertyId }, { limit: 101 });
      requireValue(listings.length <= 100, 'property listing limit');
      const now = new Date();
      const changed = await em.nativeUpdate(
        Property,
        { _id: propertyId, ownerId, version: expectedVersion },
        {
          ...canonical,
          version: expectedVersion + 1,
          updatedAt: now
        }
      );
      if (changed !== 1) throw new PersistenceConflict();
      Object.assign(property, canonical, { version: expectedVersion + 1 });
      const snapshot = propertySnapshot(property);
      for (const listing of listings) {
        // Archive/hold stay terminal; every other state becomes an unreviewed draft.
        const updated = await em.nativeUpdate(
          Listing,
          { _id: listing._id, version: listing.version },
          {
            ...snapshot,
            version: listing.version + 1,
            updatedAt: now,
            status: listing.status === 'archived' ? 'archived' : 'draft',
            submittedVersion: null,
            approvedVersion: null,
            reviewedById: null,
            publishedAt: null
          }
        );
        if (updated !== 1) throw new PersistenceConflict();
      }
      // Native writes own this transaction; detach stale managed copies before automatic flush.
      em.clear();
    });
  }

  async drift(propertyId: ObjectId): Promise<string[]> {
    const em = this.orm.em.fork();
    const property = await em.findOneOrFail(Property, { _id: propertyId });
    const snapshot = propertySnapshot(property);
    const listings = await em.find(Listing, { propertyId }, { limit: 101 });
    requireValue(listings.length <= 100, 'property listing limit');
    return listings
      .filter((listing) =>
        Object.entries(snapshot).some(
          ([key, value]) => JSON.stringify(listing[key as keyof Listing]) !== JSON.stringify(value)
        )
      )
      .map((listing) => listing._id.toHexString());
  }

  /** Explicit repair conservatively withdraws all ads and uses the same version/transaction rules. */
  async repair(propertyId: ObjectId, ownerId: ObjectId, expectedVersion: number): Promise<void> {
    const property = await this.orm.em
      .fork()
      .findOne(Property, { _id: propertyId, ownerId, version: expectedVersion });
    if (!property) throw new PersistenceConflict();
    await this.update(propertyId, ownerId, expectedVersion, property);
  }
}
