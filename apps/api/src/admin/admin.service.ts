import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { EntityManager, MikroORM, ObjectId } from '@mikro-orm/mongodb';
import type { FilterQuery } from '@mikro-orm/core';
import type {
  AdminDecisionResponse,
  AdminListingDetail,
  AdminListingsResponse,
  OwnerMediaGallery
} from '@viedom/contracts';
import { isDeepStrictEqual } from 'node:util';
import { AuthStore } from '../auth/auth.store.js';
import type { SessionRecord } from '../auth/auth.schema.js';
import type { ClientSession } from 'mongodb';
import { Configuration } from '../configuration.js';
import { Listing, Property, User } from '../database/entities.js';
import { fenceProperty } from '../database/owner-writes.js';
import { PersistenceConflict, propertySnapshot } from '../database/snapshots.js';
import { validateProperty } from '../database/domain.js';
import { processedMedia } from '../listings/listings.policy.js';
import { ownerListing } from '../listings/listings.service.js';
import { MediaAsset, MediaGallery } from '../media/media.entities.js';
import { MAX_IMAGE_BYTES } from '../media/image-processor.js';
import { MediaStorage } from '../media/storage.js';
import { ownerProperty } from '../properties/properties.service.js';
import { PendingListingsQuery } from './admin.dto.js';
import { ModerationDecision } from './moderation.entities.js';

export interface AdminActor {
  id: ObjectId;
  sessionId: ObjectId;
}
export const PUBLICATION_DAYS = 90;

export function moderationDecidable(listing: Listing): boolean {
  return (
    listing.status === 'pending_review' &&
    listing.submittedVersion === listing.version &&
    !listing.deletedAt &&
    !listing.moderationHold
  );
}

export function moderationEligible(
  listing: Listing,
  property: Property,
  owner: User,
  now = new Date()
): boolean {
  try {
    validateProperty(property);
  } catch {
    return false;
  }
  return Boolean(
    moderationDecidable(listing) &&
    (!listing.expiresAt || listing.expiresAt > now) &&
    owner.status === 'active' &&
    !owner.deletedAt &&
    owner.emailVerifiedAt &&
    owner._id.equals(listing.publisherId) &&
    property.ownerId.equals(owner._id) &&
    property._id.equals(listing.propertyId) &&
    Object.entries(propertySnapshot(property)).every(([key, value]) =>
      isDeepStrictEqual(listing[key as keyof Listing], value)
    )
  );
}

export function moderationReady(
  listing: Listing,
  property: Property,
  owner: User,
  gallery: MediaGallery | null,
  assets: MediaAsset[],
  now = new Date()
): boolean {
  if (
    !moderationEligible(listing, property, owner, now) ||
    listing.title.trim().length < 10 ||
    listing.description.trim().length < 30 ||
    property.details.bathrooms < 1 ||
    !gallery ||
    !gallery.listingId.equals(listing._id) ||
    !gallery.ownerId.equals(owner._id) ||
    !gallery.mediaIds.length ||
    gallery.mediaIds.length > 20 ||
    !gallery.coverMediaId ||
    !gallery.mediaIds.includes(gallery.coverMediaId) ||
    new Set(gallery.mediaIds).size !== gallery.mediaIds.length ||
    gallery.mediaIds.some((id) => !/^[a-f0-9]{24}$/.test(id))
  )
    return false;
  const indexed = new Map(assets.map((asset) => [asset._id.toHexString(), asset]));
  return gallery.mediaIds.every((id) => {
    const asset = indexed.get(id);
    return (
      asset &&
      asset.listingId.equals(listing._id) &&
      asset.ownerId.equals(owner._id) &&
      processedMedia(asset)
    );
  });
}

@Injectable()
export class AdminService {
  constructor(
    private readonly orm: MikroORM,
    private readonly auth: AuthStore,
    private readonly storage: MediaStorage,
    private readonly configuration: Configuration
  ) {}

  private async authorize(actor: AdminActor): Promise<void> {
    const user = await this.auth.current(actor.id, actor.sessionId);
    if (user.role !== 'ADMIN') throw new ForbiddenException();
  }

  async pending(actor: AdminActor, query: PendingListingsQuery): Promise<AdminListingsResponse> {
    await this.authorize(actor);
    const where: FilterQuery<Listing> = { status: 'pending_review', deletedAt: null };
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      where.$or = [
        { createdAt: { $lt: cursor.date } },
        { createdAt: cursor.date, _id: { $lt: cursor.id } }
      ];
    }
    const rows = await this.orm.em.fork().find(Listing, where, {
      orderBy: { createdAt: 'DESC', _id: 'DESC' },
      limit: query.limit + 1
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    await this.authorize(actor);
    return {
      items: items.map(ownerListing),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify([last.createdAt.toISOString(), last._id.toHexString()])
            ).toString('base64url')
          : null
    };
  }

  private async context(em: EntityManager, id: ObjectId) {
    const listing = await em.findOne(Listing, { _id: id, deletedAt: null });
    if (!listing) throw new NotFoundException();
    const property = await em.findOne(Property, {
      _id: listing.propertyId,
      ownerId: listing.publisherId
    });
    const owner = await em.findOne(User, { _id: listing.publisherId });
    if (!property || !owner) throw new NotFoundException();
    const gallery = await em.findOne(MediaGallery, { listingId: id, ownerId: listing.publisherId });
    const ids = gallery?.mediaIds.filter((value) => /^[a-f0-9]{24}$/.test(value)) ?? [];
    const assets = ids.length
      ? await em.find(MediaAsset, {
          _id: { $in: ids.map((value) => new ObjectId(value)) },
          listingId: id,
          ownerId: listing.publisherId
        })
      : [];
    return { listing, property, owner, gallery, assets };
  }

  private media(
    listing: Listing,
    gallery: MediaGallery | null,
    assets: MediaAsset[]
  ): OwnerMediaGallery {
    const index = new Map(assets.map((asset) => [asset._id.toHexString(), asset]));
    return {
      listingId: listing._id.toHexString(),
      version: listing.version,
      coverMediaId: gallery?.coverMediaId ?? null,
      items: (gallery?.mediaIds ?? []).flatMap((id) => {
        const asset = index.get(id);
        if (!asset) return [];
        const variant = (name: 'large' | 'thumbnail') => ({
          url: `${this.configuration.values.public.apiBaseUrl}/admin/listings/${listing._id.toHexString()}/media/${id}/${name}`,
          width: asset.variants![name].width,
          height: asset.variants![name].height,
          bytes: asset.variants![name].bytes,
          contentType: 'image/webp' as const
        });
        return [
          {
            id,
            state: asset.state,
            errorCode: asset.errorCode,
            variants: processedMedia(asset)
              ? { large: variant('large'), thumbnail: variant('thumbnail') }
              : null
          }
        ];
      })
    };
  }

  async detail(actor: AdminActor, id: ObjectId): Promise<AdminListingDetail> {
    await this.authorize(actor);
    const { listing, property, owner, gallery, assets } = await this.context(
      this.orm.em.fork(),
      id
    );
    const history = await this.orm.em
      .fork()
      .find(
        ModerationDecision,
        { listingId: id },
        { orderBy: { resultVersion: 'DESC' }, limit: 20 }
      );
    const ready = moderationReady(listing, property, owner, gallery, assets);
    await this.authorize(actor);
    const current = this.orm.em.fork();
    if (
      !(await current.findOne(Listing, { _id: id, deletedAt: null, version: listing.version })) ||
      !(await current.findOne(Property, {
        _id: property._id,
        version: property.version,
        ownerId: owner._id
      }))
    )
      throw new ConflictException();
    return {
      listing: {
        ...ownerListing(listing),
        rejectionReason:
          listing.status === 'rejected'
            ? (history.find((event) => event.resultVersion === listing.version)?.reason ?? null)
            : null,
        property: ownerProperty(property),
        submission: { canSubmit: false, missing: ['state'] }
      },
      publisher: {
        id: owner._id.toHexString(),
        email: owner.email,
        firstName: owner.firstName,
        lastName: owner.lastName,
        emailVerified: Boolean(owner.emailVerifiedAt),
        active: owner.status === 'active' && !owner.deletedAt
      },
      media: this.media(listing, gallery, assets),
      canDecide: moderationDecidable(listing) && !listing.publisherId.equals(actor.id),
      canApprove: ready && !listing.publisherId.equals(actor.id),
      history: history.map((event) => ({
        id: event._id.toHexString(),
        reviewerId: event.reviewerId.toHexString(),
        reviewedVersion: event.reviewedVersion,
        resultVersion: event.resultVersion,
        decision: event.decision,
        reason: event.reason,
        createdAt: event.createdAt.toISOString()
      }))
    };
  }

  async decide(
    actor: AdminActor,
    id: ObjectId,
    expectedVersion: number,
    reason: string | null
  ): Promise<AdminDecisionResponse> {
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      expectedVersion >= Number.MAX_SAFE_INTEGER
    )
      throw new BadRequestException();
    if (
      reason !== null &&
      (typeof reason !== 'string' || reason.trim().length < 1 || reason.trim().length > 2000)
    )
      throw new BadRequestException();
    await this.authorize(actor);
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const admin = await em.findOne(User, {
          _id: actor.id,
          role: 'ADMIN',
          status: 'active',
          deletedAt: null
        });
        if (!admin) throw new ForbiddenException();
        await this.fenceUser(em, admin, true);
        const { listing, property, owner, gallery, assets } = await this.context(em, id);
        if (listing.publisherId.equals(actor.id)) throw new ForbiddenException();
        if (
          listing.version !== expectedVersion ||
          listing.submittedVersion !== expectedVersion ||
          listing.status !== 'pending_review' ||
          listing.deletedAt ||
          listing.moderationHold
        )
          throw new ConflictException();
        if (reason === null && !moderationReady(listing, property, owner, gallery, assets))
          throw new ConflictException();
        await this.fenceUser(em, owner, false);
        await fenceProperty(em, property);
        const now = new Date();
        const update = {
          version: expectedVersion + 1,
          status: reason === null ? ('published' as const) : ('rejected' as const),
          approvedVersion: reason === null ? expectedVersion + 1 : null,
          reviewedById: actor.id,
          publishedAt: reason === null ? now : null,
          expiresAt:
            reason === null ? new Date(now.getTime() + PUBLICATION_DAYS * 86_400_000) : null,
          updatedAt: now
        };
        if (
          (await em.nativeUpdate(
            Listing,
            {
              _id: id,
              version: expectedVersion,
              status: 'pending_review',
              submittedVersion: expectedVersion,
              deletedAt: null,
              moderationHold: false
            },
            update
          )) !== 1
        )
          throw new PersistenceConflict();
        const event = Object.assign(new ModerationDecision(), {
          listingId: id,
          publisherId: owner._id,
          reviewerId: actor.id,
          reviewedVersion: expectedVersion,
          resultVersion: update.version,
          decision: reason === null ? 'approved' : 'rejected',
          reason: reason?.trim() ?? null,
          createdAt: now
        });
        em.persist(event);
        await em.flush();
        await this.authorize(actor);
        await this.fenceSession(em, actor);
        em.clear();
        return {
          id: id.toHexString(),
          version: update.version,
          status: update.status,
          rejectionReason: event.reason
        };
      });
    } catch (error) {
      if (error instanceof PersistenceConflict || transactionConflict(error))
        throw new ConflictException();
      throw error;
    }
  }

  private async fenceUser(em: EntityManager, user: User, admin: boolean): Promise<void> {
    if (
      user.version >= Number.MAX_SAFE_INTEGER ||
      (await em.nativeUpdate(
        User,
        {
          _id: user._id,
          version: user.version,
          status: admin ? 'active' : user.status,
          deletedAt: admin ? null : user.deletedAt,
          ...(admin ? { role: 'ADMIN' } : { emailVerifiedAt: user.emailVerifiedAt })
        },
        { version: user.version + 1, updatedAt: new Date() }
      )) !== 1
    )
      throw new PersistenceConflict();
  }

  private async fenceSession(em: EntityManager, actor: AdminActor): Promise<void> {
    const session = em.getTransactionContext<ClientSession>();
    if (!session) throw new PersistenceConflict();
    const sessions = em.getConnection().getCollection<SessionRecord>('auth_sessions');
    const current = await sessions.findOne(
      {
        _id: actor.sessionId,
        userId: actor.id,
        revokedAt: null,
        expiresAt: { $gt: new Date(Date.now() + 1) }
      },
      { session }
    );
    if (!current) throw new UnauthorizedException();
    const result = await sessions.updateOne(
      {
        _id: current._id,
        userId: actor.id,
        currentHash: current.currentHash,
        revokedAt: null,
        expiresAt: current.expiresAt
      },
      { $set: { expiresAt: new Date(current.expiresAt.getTime() - 1) } },
      { session }
    );
    if (result.modifiedCount !== 1) throw new PersistenceConflict();
  }

  async image(
    actor: AdminActor,
    id: ObjectId,
    mediaId: ObjectId,
    name: 'large' | 'thumbnail'
  ): Promise<Buffer> {
    await this.authorize(actor);
    const before = await this.context(this.orm.em.fork(), id);
    const asset = before.assets.find((item) => item._id.equals(mediaId));
    if (!asset || !processedMedia(asset)) throw new NotFoundException();
    const variant = asset.variants![name];
    const body = await this.storage.read(variant.key, MAX_IMAGE_BYTES);
    await this.authorize(actor);
    const after = await this.context(this.orm.em.fork(), id);
    const current = after.assets.find((item) => item._id.equals(mediaId));
    if (
      after.listing.version !== before.listing.version ||
      after.property.version !== before.property.version ||
      after.gallery?.version !== before.gallery?.version ||
      !current ||
      !processedMedia(current) ||
      current.variants?.[name].key !== variant.key
    )
      throw new NotFoundException();
    return body;
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
    const date = new Date(tuple[0]);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== tuple[0]) throw new Error();
    return { date, id: new ObjectId(tuple[1]) };
  } catch {
    throw new BadRequestException();
  }
}

function transactionConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (('code' in error && [112, 244, 251, 11000].includes(error.code as number)) ||
      ('hasErrorLabel' in error &&
        typeof error.hasErrorLabel === 'function' &&
        (error.hasErrorLabel('TransientTransactionError') ||
          error.hasErrorLabel('UnknownTransactionCommitResult'))))
  );
}
