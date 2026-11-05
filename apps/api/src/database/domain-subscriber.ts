import type { EventArgs, EventSubscriber } from '@mikro-orm/core';
import { User, Property, Listing } from './entities.js';
import {
  approximateLocation,
  listingStates,
  normalizeEmail,
  number,
  propertyTypes,
  requireValue,
  text,
  validatePoint,
  validateProperty
} from './domain.js';

export class DomainSubscriber implements EventSubscriber<User | Property | Listing> {
  beforeCreate(args: EventArgs<User | Property | Listing>): void {
    this.validate(args);
  }
  beforeUpdate(args: EventArgs<User | Property | Listing>): void {
    this.validate(args);
  }

  private validate({ entity }: EventArgs<User | Property | Listing>): void {
    if (!(entity instanceof User || entity instanceof Property || entity instanceof Listing))
      return;
    number(entity.version, 'version', 1, Number.MAX_SAFE_INTEGER, true);
    entity.updatedAt = new Date();
    if (entity instanceof User) {
      entity.email = normalizeEmail(entity.email);
      text(entity.firstName, 'firstName', 1, 100);
      text(entity.lastName, 'lastName', 1, 100);
      if (entity.phone !== null) text(entity.phone, 'phone', 1, 32);
      if (entity.passwordHash !== null) text(entity.passwordHash, 'passwordHash', 20, 512);
      requireValue(['USER', 'ADMIN'].includes(entity.role), 'role');
      requireValue(['active', 'suspended', 'deleted'].includes(entity.status), 'accountStatus');
    } else if (entity instanceof Property) {
      validateProperty(entity);
      entity.publicLocation = approximateLocation(entity.privateLocation);
    } else {
      requireValue(listingStates.includes(entity.status), 'status');
      requireValue(['rent', 'sale'].includes(entity.transactionType), 'transactionType');
      requireValue(entity.currency === 'EUR', 'currency');
      text(entity.title, 'title', 0, 160);
      text(entity.slug, 'slug', 0, 200);
      text(entity.description, 'description', 0, 10_000);
      number(entity.priceMinor, 'priceMinor', 1, 100_000_000_000, true);
      number(entity.propertyVersion, 'propertyVersion', 1, Number.MAX_SAFE_INTEGER, true);
      requireValue(propertyTypes.includes(entity.propertyType), 'propertyType');
      number(entity.areaM2, 'areaM2', 1, 100_000);
      number(entity.bedrooms, 'bedrooms', 0, 100, true);
      number(entity.bathrooms, 'bathrooms', 0, 100, true);
      text(entity.city, 'city', 1, 100);
      text(entity.neighborhood, 'neighborhood', 0, 100);
      validatePoint(entity.publicLocation);
    }
  }
}
