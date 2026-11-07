import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { EntityManager, MikroORM, ObjectId } from '@mikro-orm/mongodb';
import type { FilterQuery } from '@mikro-orm/core';
import type {
  ListingContent,
  OwnerListingDetail,
  OwnerListingsResponse,
  OwnerListingSummary
} from '@viedom/contracts';
import { Listing, Property, User } from '../database/entities.js';
import { OwnerWrites, fenceProperty } from '../database/owner-writes.js';
import { PersistenceConflict, propertySnapshot } from '../database/snapshots.js';
import { ownerProperty } from '../properties/properties.service.js';
import { ListingsPolicy, invalidateReview, listingSlug } from './listings.policy.js';
import { CreateListingDto, OwnerListingsQuery, UpdateListingDto } from './listings.dto.js';
import { ModerationDecision } from '../admin/moderation.entities.js';

export function ownerListing(listing: Listing): OwnerListingSummary {
  return {
    id: listing._id.toHexString(),
    propertyId: listing.propertyId.toHexString(),
    version: listing.version,
    propertyVersion: listing.propertyVersion,
    transactionType: listing.transactionType,
    title: listing.title,
    description: listing.description,
    priceMinor: listing.priceMinor,
    currency: listing.currency,
    status: listing.status,
    moderationHold: listing.moderationHold,
    submittedVersion: listing.submittedVersion,
    rejectionReason: null,
    publishedAt: listing.publishedAt?.toISOString() ?? null,
    expiresAt: listing.expiresAt?.toISOString() ?? null,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString()
  };
}

function content(input: ListingContent) {
  return {
    transactionType: input.transactionType,
    title: input.title,
    description: input.description,
    priceMinor: input.priceMinor,
    currency: input.currency,
    slug: listingSlug(input.title)
  };
}

@Injectable()
export class ListingsService {
  constructor(
    private readonly orm: MikroORM,
    private readonly writes: OwnerWrites,
    private readonly policy: ListingsPolicy
  ) {}

  private async owned(em: EntityManager, ownerId: ObjectId, id: ObjectId) {
    const listing = await em.findOne(Listing, { _id: id, publisherId: ownerId, deletedAt: null });
    if (!listing) throw new NotFoundException();
    const property = await em.findOne(Property, { _id: listing.propertyId, ownerId });
    if (!property) throw new NotFoundException();
    return { listing, property };
  }

  private async detail(
    listing: Listing,
    property: Property,
    owner: User
  ): Promise<OwnerListingDetail> {
    const decision =
      listing.status === 'rejected'
        ? await this.orm.em.fork().findOne(ModerationDecision, {
            listingId: listing._id,
            resultVersion: listing.version,
            decision: 'rejected'
          })
        : null;
    return {
      ...ownerListing(listing),
      rejectionReason: decision?.reason ?? null,
      property: ownerProperty(property),
      submission: await this.policy.submission(listing, property, owner)
    };
  }

  create(ownerId: ObjectId, input: CreateListingDto): Promise<OwnerListingDetail> {
    return this.writes.run(ownerId, async (em, owner) => {
      const property = await em.findOne(Property, { _id: new ObjectId(input.propertyId), ownerId });
      if (!property) throw new NotFoundException();
      if (property.version !== input.expectedPropertyVersion) throw new ConflictException();
      if ((await em.count(Listing, { propertyId: property._id })) >= 100)
        throw new ConflictException();
      const propertyUpdatedAt = await fenceProperty(em, property);
      const listing = Object.assign(new Listing(), content(input), {
        propertyId: property._id,
        publisherId: ownerId,
        ...propertySnapshot(property)
      });
      em.persist(listing);
      await em.flush();
      property.updatedAt = propertyUpdatedAt;
      return this.detail(listing, property, owner);
    });
  }

  async read(ownerId: ObjectId, id: ObjectId): Promise<OwnerListingDetail> {
    const em = this.orm.em.fork();
    const { listing, property } = await this.owned(em, ownerId, id);
    const owner = await em.findOne(User, { _id: ownerId, status: 'active', deletedAt: null });
    if (!owner) throw new ForbiddenException();
    return this.detail(listing, property, owner);
  }

  async list(ownerId: ObjectId, query: OwnerListingsQuery): Promise<OwnerListingsResponse> {
    const where: FilterQuery<Listing> = { publisherId: ownerId, deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      where.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
      ];
    }
    const rows = await this.orm.em.fork().find(Listing, where, {
      orderBy: { createdAt: 'DESC', _id: 'DESC' },
      limit: query.limit + 1
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const rejected = items.filter((item) => item.status === 'rejected');
    const decisions = rejected.length
      ? await this.orm.em.fork().find(ModerationDecision, {
          $or: rejected.map((item) => ({
            listingId: item._id,
            resultVersion: item.version,
            decision: 'rejected' as const
          }))
        })
      : [];
    return {
      items: items.map((item) => ({
        ...ownerListing(item),
        rejectionReason:
          item.status === 'rejected'
            ? (decisions.find(
                (event) => event.listingId.equals(item._id) && event.resultVersion === item.version
              )?.reason ?? null)
            : null
      })),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify([last.createdAt.toISOString(), last._id.toHexString()])
            ).toString('base64url')
          : null
    };
  }

  update(ownerId: ObjectId, id: ObjectId, input: UpdateListingDto): Promise<OwnerListingDetail> {
    return this.change(ownerId, id, input.expectedVersion, async (listing) => {
      if (listing.status === 'archived') throw new ConflictException();
      return { ...content(input), ...invalidateReview() };
    });
  }

  action(
    ownerId: ObjectId,
    id: ObjectId,
    expectedVersion: number,
    action: 'submit' | 'pause' | 'resume' | 'archive'
  ): Promise<OwnerListingDetail> {
    return this.change(ownerId, id, expectedVersion, async (listing, property, owner) => {
      if (action === 'archive') {
        if (listing.status === 'archived') throw new ConflictException();
        return { ...invalidateReview(), status: 'archived' as const };
      }
      if (action === 'pause') {
        if (listing.status !== 'published') throw new ConflictException();
        return { ...invalidateReview(), status: 'paused' as const };
      }
      if (!owner.emailVerifiedAt) throw new ForbiddenException();
      if (
        !(action === 'resume'
          ? listing.status === 'paused'
          : ['draft', 'rejected'].includes(listing.status))
      )
        throw new ConflictException();
      const readiness = await this.policy.submission(listing, property, owner);
      if (!readiness.canSubmit) throw new ConflictException();
      return {
        ...invalidateReview(),
        status: 'pending_review' as const,
        submittedVersion: listing.version + 1
      };
    });
  }

  private change(
    ownerId: ObjectId,
    id: ObjectId,
    expectedVersion: number,
    changes: (listing: Listing, property: Property, owner: User) => Promise<Partial<Listing>>
  ): Promise<OwnerListingDetail> {
    return this.writes.run(ownerId, async (em, owner) => {
      const { listing, property } = await this.owned(em, ownerId, id);
      if (
        listing.version !== expectedVersion ||
        listing.version >= Number.MAX_SAFE_INTEGER ||
        listing.propertyVersion !== property.version
      )
        throw new ConflictException();
      const update = {
        ...(await changes(listing, property, owner)),
        version: listing.version + 1,
        updatedAt: new Date()
      };
      property.updatedAt = await fenceProperty(em, property);
      if (
        (await em.nativeUpdate(
          Listing,
          { _id: id, publisherId: ownerId, version: expectedVersion },
          update
        )) !== 1
      )
        throw new PersistenceConflict();
      Object.assign(listing, update);
      return this.detail(listing, property, owner);
    });
  }
}

function decodeCursor(value: string) {
  try {
    const tuple: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      typeof tuple[0] !== 'string' ||
      typeof tuple[1] !== 'string' ||
      !/^[a-f0-9]{24}$/.test(tuple[1])
    )
      throw new Error();
    const createdAt = new Date(tuple[0]);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== tuple[0])
      throw new Error();
    return { createdAt, id: new ObjectId(tuple[1]) };
  } catch {
    throw new BadRequestException();
  }
}
