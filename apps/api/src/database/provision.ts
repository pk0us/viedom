import { MikroORM } from '@mikro-orm/mongodb';
import { isDeepStrictEqual } from 'node:util';
import { listingStates, propertyTypes } from './domain.js';
import { authValidators } from '../auth/auth.schema.js';
import { mediaValidators } from '../media/media.schema.js';
import { moderationValidators } from '../admin/moderation.entities.js';
import { adminProvisioningValidators } from './admin-provision.js';

const string = (maxLength: number, minLength = 0) => ({ bsonType: 'string', minLength, maxLength });
const numeric = (minimum: number, maximum: number, integer = false) => ({
  bsonType: ['double', 'int', 'long'],
  minimum,
  maximum,
  ...(integer ? { multipleOf: 1 } : {})
});
const nullableDate = { bsonType: ['date', 'null'] };
const nullableId = { bsonType: ['objectId', 'null'] };
function object(properties: Record<string, unknown>) {
  return {
    bsonType: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties
  };
}
const point = object({
  type: { enum: ['Point'] },
  coordinates: { bsonType: 'array', minItems: 2, maxItems: 2, items: numeric(-180, 180) }
});
const base = {
  _id: { bsonType: 'objectId' },
  version: numeric(1, Number.MAX_SAFE_INTEGER, true),
  createdAt: { bsonType: 'date' },
  updatedAt: { bsonType: 'date' },
  fixtureKey: { bsonType: ['string', 'null'], maxLength: 100 }
};
const details = object({
  areaM2: numeric(1, 100_000),
  bedrooms: numeric(0, 100, true),
  bathrooms: numeric(0, 100, true),
  floor: numeric(-10, 200, true),
  yearBuilt: { ...numeric(1800, 2100, true), bsonType: ['double', 'int', 'long', 'null'] },
  amenities: { bsonType: 'array', maxItems: 30, uniqueItems: true, items: string(50, 1) }
});
const address = object({
  countryCode: { enum: ['GR'] },
  city: string(100, 1),
  neighborhood: string(100),
  street: string(200)
});
// GeoJSON has longitude first. The array schema bounds both axes; latitude needs a tighter bound.
const latitude = (field: string) => ({
  $and: [
    { $gte: [{ $arrayElemAt: [`$${field}.coordinates`, 1] }, -90] },
    { $lte: [{ $arrayElemAt: [`$${field}.coordinates`, 1] }, 90] }
  ]
});
export const validators = {
  users: {
    $jsonSchema: object({
      ...base,
      email: {
        ...string(254, 3),
        pattern: "^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,}$"
      },
      passwordHash: { bsonType: ['string', 'null'], minLength: 20, maxLength: 512 },
      firstName: string(100, 1),
      lastName: string(100, 1),
      phone: { bsonType: ['string', 'null'], minLength: 1, maxLength: 32 },
      role: { enum: ['USER', 'ADMIN'] },
      status: { enum: ['active', 'suspended', 'deleted'] },
      emailVerifiedAt: nullableDate,
      deletedAt: nullableDate
    })
  },
  properties: {
    $and: [
      {
        $jsonSchema: object({
          ...base,
          ownerId: { bsonType: 'objectId' },
          type: { enum: propertyTypes },
          details,
          address,
          privateLocation: point,
          publicLocation: point
        })
      },
      { $expr: { $and: [latitude('privateLocation'), latitude('publicLocation')] } }
    ]
  },
  listings: {
    $and: [
      {
        $jsonSchema: object({
          ...base,
          propertyId: { bsonType: 'objectId' },
          publisherId: { bsonType: 'objectId' },
          transactionType: { enum: ['rent', 'sale'] },
          title: string(160),
          slug: string(200),
          description: string(10_000),
          priceMinor: numeric(1, 100_000_000_000, true),
          currency: { enum: ['EUR'] },
          status: { enum: listingStates },
          submittedVersion: {
            ...numeric(1, Number.MAX_SAFE_INTEGER, true),
            bsonType: ['double', 'int', 'long', 'null']
          },
          approvedVersion: {
            ...numeric(1, Number.MAX_SAFE_INTEGER, true),
            bsonType: ['double', 'int', 'long', 'null']
          },
          reviewedById: nullableId,
          publishedAt: nullableDate,
          expiresAt: nullableDate,
          deletedAt: nullableDate,
          moderationHold: { bsonType: 'bool' },
          propertyVersion: numeric(1, Number.MAX_SAFE_INTEGER, true),
          publicLocation: point,
          propertyType: { enum: propertyTypes },
          areaM2: numeric(1, 100_000),
          bedrooms: numeric(0, 100, true),
          bathrooms: numeric(0, 100, true),
          city: string(100, 1),
          neighborhood: string(100)
        })
      },
      { $expr: latitude('publicLocation') }
    ]
  }
};

/** Reviewed additive changes only: never drop collections, documents or unknown indexes. */
export async function provision(orm: MikroORM): Promise<void> {
  const db = orm.em.getConnection().getDb();
  for (const [name, validator] of Object.entries({
    ...validators,
    ...authValidators,
    ...mediaValidators,
    ...moderationValidators,
    ...adminProvisioningValidators
  })) {
    const existing = await db.listCollections({ name }, { nameOnly: false }).next();
    if (!existing) {
      await db.createCollection(name, {
        validator,
        validationLevel: 'strict',
        validationAction: 'error'
      });
    } else {
      // readWrite can create collections/indexes, but cannot collMod. Never broaden app privileges.
      // Existing validator changes need a separately reviewed operator migration.
      if (
        !isDeepStrictEqual(existing.options?.validator, validator) ||
        existing.options?.validationLevel !== 'strict' ||
        existing.options?.validationAction !== 'error'
      ) {
        throw new Error(`Existing ${name} validator needs a reviewed migration.`);
      }
      if (await db.collection(name).findOne({ $nor: [validator] }, { projection: { _id: 1 } })) {
        throw new Error(`Existing ${name} records need a reviewed migration before provisioning.`);
      }
    }
  }
  await db
    .collection('users')
    .createIndex({ email: 1 }, { name: 'email_normalized_unique', unique: true });
  await db
    .collection('properties')
    .createIndex({ ownerId: 1, createdAt: -1, _id: -1 }, { name: 'owner_created' });
  const listings = db.collection('listings');
  await listings.createIndex({ status: 1, createdAt: -1, _id: -1 }, { name: 'status_created' });
  await db
    .collection('moderation_decisions')
    .createIndex(
      { listingId: 1, resultVersion: -1 },
      { name: 'listing_decision_version_unique', unique: true }
    );
  await listings.createIndex({ publicLocation: '2dsphere' }, { name: 'public_location_geo' });
  await listings.createIndex(
    { status: 1, transactionType: 1, priceMinor: 1, publicLocation: '2dsphere' },
    { name: 'public_search_geo' }
  );
  await listings.createIndex({ status: 1, publishedAt: -1, _id: -1 }, { name: 'status_published' });
  await listings.createIndex(
    { publisherId: 1, createdAt: -1, _id: -1 },
    { name: 'publisher_created' }
  );
  await listings.createIndex({ propertyId: 1 }, { name: 'property_lookup' });
  await db
    .collection('media_galleries')
    .createIndex({ listingId: 1 }, { name: 'media_listing_unique', unique: true });
  await db
    .collection('media_assets')
    .createIndex({ listingId: 1, ownerId: 1 }, { name: 'media_owner_listing' });
  await db
    .collection('media_assets')
    .createIndex({ state: 1, availableAt: 1, leaseUntil: 1 }, { name: 'media_processing_ready' });
  await db
    .collection('media_assets')
    .createIndex({ cleanupAt: 1 }, { name: 'media_cleanup_ready' });
  await db
    .collection('auth_identities')
    .createIndex({ provider: 1, subject: 1 }, { unique: true, name: 'provider_subject_unique' });
  await db.collection('auth_identities').createIndex({ userId: 1 }, { name: 'identity_user' });
  await db.collection('auth_sessions').createIndex({ userId: 1 }, { name: 'session_user' });
  await db
    .collection('auth_actions')
    .createIndex({ userId: 1, purpose: 1 }, { unique: true, name: 'action_user_purpose_unique' });
  await db
    .collection('auth_deliveries')
    .createIndex({ availableAt: 1, leaseUntil: 1 }, { name: 'delivery_ready' });
  await db
    .collection('auth_refresh_tokens')
    .createIndex({ sessionId: 1 }, { name: 'token_family' });
  for (const name of [
    'auth_sessions',
    'auth_refresh_tokens',
    'auth_oauth_states',
    'auth_rate_limits',
    'auth_actions',
    'auth_deliveries'
  ]) {
    await db
      .collection(name)
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiry_cleanup' });
  }
}
