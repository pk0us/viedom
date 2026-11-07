import { EntitySchema } from '@mikro-orm/core';
import { ObjectId } from '@mikro-orm/mongodb';
import { MediaAssetSchema, MediaGallerySchema } from '../media/media.entities.js';
import { ModerationDecisionSchema } from '../admin/moderation.entities.js';
import { FirstAdminGrantSchema } from './admin-provision.js';
import type {
  GeoPoint,
  ListingState,
  PropertyAddress,
  PropertyContent,
  PropertyDetails,
  PropertyType
} from './domain.js';

/** Entities must never be returned from controllers. Hidden metadata is defense in depth. */
class RecordBase {
  _id = new ObjectId();
  version = 1;
  createdAt = new Date();
  updatedAt = new Date();
  fixtureKey: string | null = null;

  toJSON(): never {
    throw new Error('Persistence entities require an explicit response mapper.');
  }
}
export class User extends RecordBase {
  email!: string;
  passwordHash: string | null = null;
  firstName!: string;
  lastName!: string;
  phone: string | null = null;
  role: 'USER' | 'ADMIN' = 'USER';
  status: 'active' | 'suspended' | 'deleted' = 'active';
  emailVerifiedAt: Date | null = null;
  deletedAt: Date | null = null;
}
export class Property extends RecordBase implements PropertyContent {
  ownerId!: ObjectId;
  type!: PropertyType;
  details!: PropertyDetails;
  address!: PropertyAddress;
  privateLocation!: GeoPoint;
  publicLocation!: GeoPoint;
}
export class Listing extends RecordBase {
  propertyId!: ObjectId;
  publisherId!: ObjectId;
  transactionType: 'rent' | 'sale' = 'rent';
  title = '';
  slug = '';
  description = '';
  priceMinor = 1;
  currency = 'EUR' as const;
  status: ListingState = 'draft';
  submittedVersion: number | null = null;
  approvedVersion: number | null = null;
  reviewedById: ObjectId | null = null;
  publishedAt: Date | null = null;
  expiresAt: Date | null = null;
  deletedAt: Date | null = null;
  moderationHold = false;
  // Search snapshot contains public property fields only. Version detects drift.
  propertyVersion!: number;
  publicLocation!: GeoPoint;
  propertyType!: PropertyType;
  areaM2!: number;
  bedrooms!: number;
  bathrooms!: number;
  city!: string;
  neighborhood!: string;
}

const base = {
  _id: { type: 'ObjectId', primary: true, hidden: true },
  version: { type: 'number' },
  createdAt: { type: 'Date' },
  updatedAt: { type: 'Date' },
  fixtureKey: { type: 'string', nullable: true, hidden: true }
} as const;
export const UserSchema = new EntitySchema<User>({
  class: User,
  tableName: 'users',
  properties: {
    ...base,
    email: { type: 'string', hidden: true },
    passwordHash: { type: 'string', nullable: true, hidden: true },
    firstName: { type: 'string', hidden: true },
    lastName: { type: 'string', hidden: true },
    phone: { type: 'string', nullable: true, hidden: true },
    role: { type: 'string', hidden: true },
    status: { type: 'string', hidden: true },
    emailVerifiedAt: { type: 'Date', nullable: true, hidden: true },
    deletedAt: { type: 'Date', nullable: true, hidden: true }
  }
});
export const PropertySchema = new EntitySchema<Property>({
  class: Property,
  tableName: 'properties',
  properties: {
    ...base,
    ownerId: { type: 'ObjectId', hidden: true },
    type: { type: 'string' },
    details: { type: 'json' },
    address: { type: 'json', hidden: true },
    privateLocation: { type: 'json', hidden: true },
    publicLocation: { type: 'json' }
  }
});
export const ListingSchema = new EntitySchema<Listing>({
  class: Listing,
  tableName: 'listings',
  properties: {
    ...base,
    propertyId: { type: 'ObjectId', hidden: true },
    publisherId: { type: 'ObjectId', hidden: true },
    transactionType: { type: 'string' },
    title: { type: 'string' },
    slug: { type: 'string' },
    description: { type: 'string' },
    priceMinor: { type: 'number' },
    currency: { type: 'string' },
    status: { type: 'string', hidden: true },
    submittedVersion: { type: 'number', nullable: true, hidden: true },
    approvedVersion: { type: 'number', nullable: true, hidden: true },
    reviewedById: { type: 'ObjectId', nullable: true, hidden: true },
    publishedAt: { type: 'Date', nullable: true },
    expiresAt: { type: 'Date', nullable: true, hidden: true },
    deletedAt: { type: 'Date', nullable: true, hidden: true },
    moderationHold: { type: 'boolean', hidden: true },
    propertyVersion: { type: 'number', hidden: true },
    publicLocation: { type: 'json' },
    propertyType: { type: 'string' },
    areaM2: { type: 'number' },
    bedrooms: { type: 'number' },
    bathrooms: { type: 'number' },
    city: { type: 'string' },
    neighborhood: { type: 'string' }
  }
});
export const entities = [
  UserSchema,
  PropertySchema,
  ListingSchema,
  MediaAssetSchema,
  MediaGallerySchema,
  ModerationDecisionSchema,
  FirstAdminGrantSchema
];
