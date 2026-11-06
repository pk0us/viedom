import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import type { OwnerProperty, PropertyContent } from '@viedom/contracts';
import { Listing, Property } from '../database/entities.js';
import { approximateLocation, validateProperty } from '../database/domain.js';
import { PropertySnapshots } from '../database/snapshots.js';
import { OwnerWrites } from '../database/owner-writes.js';

export function ownerProperty(property: Property): OwnerProperty {
  return {
    id: property._id.toHexString(),
    version: property.version,
    type: property.type,
    details: structuredClone(property.details),
    address: structuredClone(property.address),
    privateLocation: structuredClone(property.privateLocation),
    publicLocation: structuredClone(property.publicLocation),
    createdAt: property.createdAt.toISOString(),
    updatedAt: property.updatedAt.toISOString()
  };
}

@Injectable()
export class PropertiesService {
  constructor(
    private readonly orm: MikroORM,
    private readonly writes: OwnerWrites,
    private readonly snapshots: PropertySnapshots
  ) {}

  private content(input: PropertyContent): PropertyContent {
    const content = {
      type: input.type,
      details: structuredClone(input.details),
      address: structuredClone(input.address),
      privateLocation: structuredClone(input.privateLocation)
    };
    try {
      validateProperty(content);
    } catch {
      throw new BadRequestException();
    }
    return content;
  }

  create(ownerId: ObjectId, input: PropertyContent): Promise<OwnerProperty> {
    const content = this.content(input);
    return this.writes.run(ownerId, async (em) => {
      const property = Object.assign(new Property(), content, {
        ownerId,
        publicLocation: approximateLocation(content.privateLocation)
      });
      em.persist(property);
      await em.flush();
      return ownerProperty(property);
    });
  }

  async read(ownerId: ObjectId, id: ObjectId): Promise<OwnerProperty> {
    const property = await this.orm.em.fork().findOne(Property, { _id: id, ownerId });
    if (!property) throw new NotFoundException();
    return ownerProperty(property);
  }

  update(
    ownerId: ObjectId,
    id: ObjectId,
    expectedVersion: number,
    input: PropertyContent
  ): Promise<OwnerProperty> {
    const content = this.content(input);
    return this.writes.run(ownerId, async (em) => {
      if (!(await em.findOne(Property, { _id: id, ownerId }))) throw new NotFoundException();
      if ((await em.count(Listing, { propertyId: id })) > 100) throw new ConflictException();
      return ownerProperty(
        await this.snapshots.updateInTransaction(em, id, ownerId, expectedVersion, content)
      );
    });
  }
}
