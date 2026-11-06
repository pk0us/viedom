import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { EntityManager, MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { randomUUID } from 'node:crypto';
import type { MediaUploadResponse, OwnerMediaGallery } from '@viedom/contracts';
import { Configuration } from '../configuration.js';
import { Listing, Property, User } from '../database/entities.js';
import { OwnerWrites, fenceProperty } from '../database/owner-writes.js';
import { PersistenceConflict } from '../database/snapshots.js';
import { ListingsPolicy, invalidateReview } from '../listings/listings.policy.js';
import { MediaAsset, MediaGallery } from './media.entities.js';
import type { StoredVariant } from './media.entities.js';
import { CompleteMediaDto, GalleryDto, UploadMediaDto } from './media.dto.js';
import {
  CLEANUP_GRACE_MS,
  MAX_GALLERY_IMAGES,
  MAX_IMAGE_BYTES,
  UPLOAD_SECONDS
} from './image-processor.js';
import { MediaStorage } from './storage.js';

export function cleanupTime(asset: MediaAsset): Date {
  return new Date(
    Math.max(Date.now(), asset.uploadExpiresAt.getTime(), asset.leaseUntil?.getTime() ?? 0) +
      CLEANUP_GRACE_MS
  );
}

@Injectable()
export class MediaService {
  constructor(
    private readonly orm: MikroORM,
    private readonly writes: OwnerWrites,
    private readonly storage: MediaStorage,
    private readonly policy: ListingsPolicy,
    private readonly configuration: Configuration
  ) {}

  private async owned(em: EntityManager, ownerId: ObjectId, id: ObjectId) {
    const listing = await em.findOne(Listing, { _id: id, publisherId: ownerId, deletedAt: null });
    if (!listing) throw new NotFoundException();
    const property = await em.findOne(Property, { _id: listing.propertyId, ownerId });
    if (!property) throw new NotFoundException();
    return { listing, property };
  }

  private async gallery(em: EntityManager, listing: Listing): Promise<MediaGallery> {
    return (
      (await em.findOne(MediaGallery, { listingId: listing._id, ownerId: listing.publisherId })) ??
      Object.assign(new MediaGallery(), { listingId: listing._id, ownerId: listing.publisherId })
    );
  }

  private async response(
    em: EntityManager,
    listing: Listing,
    gallery: MediaGallery
  ): Promise<OwnerMediaGallery> {
    const assets = gallery.mediaIds.length
      ? await em.find(MediaAsset, {
          _id: { $in: gallery.mediaIds.map((id) => new ObjectId(id)) },
          listingId: listing._id,
          ownerId: listing.publisherId
        })
      : [];
    const index = new Map(assets.map((asset) => [asset._id.toHexString(), asset]));
    return {
      listingId: listing._id.toHexString(),
      version: listing.version,
      coverMediaId: gallery.coverMediaId,
      items: gallery.mediaIds.flatMap((id) => {
        const asset = index.get(id);
        if (!asset) return [];
        const variant = (name: 'large' | 'thumbnail') => {
          const stored = asset.variants![name];
          return {
            url: `${this.configuration.values.public.apiBaseUrl}/listings/${listing._id.toHexString()}/media/${id}/${name}`,
            width: stored.width,
            height: stored.height,
            bytes: stored.bytes,
            contentType: 'image/webp' as const
          };
        };
        return [
          {
            id,
            state: asset.state,
            errorCode: asset.errorCode,
            variants:
              asset.state === 'ready' && asset.variants
                ? { large: variant('large'), thumbnail: variant('thumbnail') }
                : null
          }
        ];
      })
    };
  }

  async read(ownerId: ObjectId, id: ObjectId): Promise<OwnerMediaGallery> {
    const em = this.orm.em.fork();
    if (!(await em.findOne(User, { _id: ownerId, status: 'active', deletedAt: null })))
      throw new ForbiddenException();
    const { listing } = await this.owned(em, ownerId, id);
    return this.response(em, listing, await this.gallery(em, listing));
  }

  async upload(
    ownerId: ObjectId,
    id: ObjectId,
    input: UploadMediaDto
  ): Promise<MediaUploadResponse> {
    const asset = Object.assign(new MediaAsset(), {
      listingId: id,
      ownerId,
      contentType: input.contentType,
      expectedBytes: input.bytes,
      uploadExpiresAt: new Date(Date.now() + UPLOAD_SECONDS * 1000)
    });
    asset.originalKey = `originals/${asset._id.toHexString()}/${randomUUID()}`;
    const gallery = await this.change(
      ownerId,
      id,
      input.expectedVersion,
      async (em, _listing, gallery) => {
        if (gallery.mediaIds.length >= MAX_GALLERY_IMAGES) throw new ConflictException();
        const recent = await em.count(MediaAsset, {
          ownerId,
          createdAt: { $gte: new Date(Date.now() - 3_600_000) }
        });
        if (recent >= 40) throw new ConflictException();
        gallery.mediaIds.push(asset._id.toHexString());
        em.persist(asset);
      }
    );
    const remainingSeconds = Math.floor((asset.uploadExpiresAt.getTime() - Date.now()) / 1000);
    if (remainingSeconds < 1) throw new ServiceUnavailableException();
    const uploadUrl = await this.storage.signUpload(
      asset.originalKey,
      asset.contentType,
      asset.expectedBytes,
      remainingSeconds
    );
    return {
      mediaId: asset._id.toHexString(),
      uploadUrl,
      expiresAt: asset.uploadExpiresAt.toISOString(),
      headers: { 'Content-Type': asset.contentType },
      gallery
    };
  }

  async complete(
    ownerId: ObjectId,
    id: ObjectId,
    input: CompleteMediaDto
  ): Promise<OwnerMediaGallery> {
    const em = this.orm.em.fork();
    await this.owned(em, ownerId, id);
    const asset = await em.findOne(MediaAsset, {
      _id: new ObjectId(input.mediaId),
      listingId: id,
      ownerId
    });
    if (!asset) throw new NotFoundException();
    if (['queued', 'processing', 'ready'].includes(asset.state)) return this.read(ownerId, id);
    if (asset.state !== 'awaiting_upload' || asset.uploadExpiresAt.getTime() <= Date.now())
      throw new ConflictException();
    const head = await this.storage.head(asset.originalKey).catch((error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'name' in error &&
        ['NotFound', 'NoSuchKey'].includes(String(error.name))
      )
        throw new ConflictException();
      throw new ServiceUnavailableException();
    });
    const valid =
      head.bytes === asset.expectedBytes &&
      head.bytes <= MAX_IMAGE_BYTES &&
      head.contentType === asset.contentType;
    return this.change(
      ownerId,
      id,
      input.expectedVersion,
      async (transaction, _listing, gallery) => {
        const current = await transaction.findOne(MediaAsset, {
          _id: asset._id,
          listingId: id,
          ownerId
        });
        if (!current || !gallery.mediaIds.includes(input.mediaId)) throw new NotFoundException();
        if (current.state !== 'awaiting_upload' || current.uploadExpiresAt.getTime() <= Date.now())
          throw new ConflictException();
        current.state = valid ? 'queued' : 'failed';
        current.errorCode = valid ? null : 'invalid_image';
        current.availableAt = new Date();
        current.updatedAt = new Date();
        if (!valid) current.cleanupAt = cleanupTime(current);
      }
    );
  }

  update(ownerId: ObjectId, id: ObjectId, input: GalleryDto): Promise<OwnerMediaGallery> {
    return this.change(ownerId, id, input.expectedVersion, async (em, _listing, gallery) => {
      if (
        input.mediaIds.length !== gallery.mediaIds.length ||
        input.mediaIds.some((mediaId) => !gallery.mediaIds.includes(mediaId))
      )
        throw new BadRequestException();
      if (input.coverMediaId !== null) {
        if (!input.mediaIds.includes(input.coverMediaId)) throw new BadRequestException();
        const cover = await em.findOne(MediaAsset, {
          _id: new ObjectId(input.coverMediaId),
          listingId: id,
          ownerId,
          state: 'ready'
        });
        if (!cover?.variants) throw new ConflictException();
      }
      const assets = input.mediaIds.length
        ? await em.count(MediaAsset, {
            _id: { $in: input.mediaIds.map((mediaId) => new ObjectId(mediaId)) },
            listingId: id,
            ownerId,
            state: { $ne: 'deleted' }
          })
        : 0;
      if (assets !== input.mediaIds.length) throw new BadRequestException();
      gallery.mediaIds = [...input.mediaIds];
      gallery.coverMediaId = input.coverMediaId;
    });
  }

  remove(ownerId: ObjectId, id: ObjectId, mediaId: ObjectId, expectedVersion: number) {
    return this.change(ownerId, id, expectedVersion, async (em, _listing, gallery) => {
      const asset = await em.findOne(MediaAsset, { _id: mediaId, listingId: id, ownerId });
      if (!asset || !gallery.mediaIds.includes(mediaId.toHexString()))
        throw new NotFoundException();
      asset.state = 'deleted';
      asset.cleanupAt = cleanupTime(asset);
      asset.cleanedAt = null;
      asset.updatedAt = new Date();
      gallery.mediaIds = gallery.mediaIds.filter((value) => value !== mediaId.toHexString());
      if (gallery.coverMediaId === mediaId.toHexString()) gallery.coverMediaId = null;
    });
  }

  async finish(
    assetId: ObjectId,
    leaseToken: string,
    outcome:
      | { variants: { large: StoredVariant; thumbnail: StoredVariant } }
      | { errorCode: 'invalid_image' | 'processing_failed' }
  ): Promise<boolean> {
    const snapshot = await this.orm.em.fork().findOne(MediaAsset, {
      _id: assetId,
      state: 'processing',
      leaseToken,
      leaseUntil: { $gt: new Date() }
    });
    if (!snapshot) return false;
    try {
      await this.change(
        snapshot.ownerId,
        snapshot.listingId,
        null,
        async (em, _listing, gallery) => {
          const asset = await em.findOne(MediaAsset, {
            _id: assetId,
            state: 'processing',
            leaseToken,
            leaseUntil: { $gt: new Date() }
          });
          if (!asset || !gallery.mediaIds.includes(assetId.toHexString()))
            throw new ConflictException();
          asset.state = 'variants' in outcome ? 'ready' : 'failed';
          asset.variants = 'variants' in outcome ? outcome.variants : null;
          asset.errorCode = 'errorCode' in outcome ? outcome.errorCode : null;
          asset.cleanupAt = cleanupTime(asset);
          asset.cleanedAt = null;
          asset.updatedAt = new Date();
          asset.leaseToken = null;
          asset.leaseUntil = null;
          if (asset.state === 'ready' && !gallery.coverMediaId)
            gallery.coverMediaId = asset._id.toHexString();
        }
      );
      return true;
    } catch (error) {
      if (!(
        error instanceof ForbiddenException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ))
        throw error;
      return false;
    }
  }

  async expire(snapshot: MediaAsset): Promise<void> {
    try {
      await this.change(
        snapshot.ownerId,
        snapshot.listingId,
        null,
        async (em, _listing, gallery) => {
          const asset = await em.findOne(MediaAsset, {
            _id: snapshot._id,
            state: 'awaiting_upload',
            uploadExpiresAt: { $lte: new Date() }
          });
          if (!asset) throw new ConflictException();
          asset.state = 'deleted';
          asset.cleanupAt = cleanupTime(asset);
          asset.cleanedAt = null;
          asset.updatedAt = new Date();
          gallery.mediaIds = gallery.mediaIds.filter((id) => id !== asset._id.toHexString());
        }
      );
    } catch (error) {
      if (!(
        error instanceof ForbiddenException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ))
        throw error;
      await this.cancelUnavailable(snapshot);
    }
  }

  async cancelUnavailable(snapshot: MediaAsset): Promise<boolean> {
    const em = this.orm.em.fork();
    const owner = await em.findOne(User, {
      _id: snapshot.ownerId,
      status: 'active',
      deletedAt: null
    });
    const listing = await em.findOne(Listing, {
      _id: snapshot.listingId,
      publisherId: snapshot.ownerId,
      deletedAt: null,
      status: { $ne: 'archived' }
    });
    if (owner && listing) return false;
    const changed = await em.nativeUpdate(
      MediaAsset,
      {
        _id: snapshot._id,
        state: snapshot.state,
        leaseToken: snapshot.leaseToken
      },
      {
        state: 'deleted',
        cleanupAt: cleanupTime(snapshot),
        cleanedAt: null,
        updatedAt: new Date()
      }
    );
    return changed === 1;
  }

  private change(
    ownerId: ObjectId,
    id: ObjectId,
    expectedVersion: number | null,
    change: (em: EntityManager, listing: Listing, gallery: MediaGallery) => Promise<void>
  ): Promise<OwnerMediaGallery> {
    return this.writes.run(ownerId, async (em) => {
      const { listing, property } = await this.owned(em, ownerId, id);
      if (
        listing.status === 'archived' ||
        listing.version >= Number.MAX_SAFE_INTEGER ||
        (expectedVersion !== null && listing.version !== expectedVersion) ||
        listing.propertyVersion !== property.version
      )
        throw new ConflictException();
      const gallery = await this.gallery(em, listing);
      await change(em, listing, gallery);
      gallery.version++;
      gallery.updatedAt = new Date();
      em.persist(gallery);
      await em.flush();
      await fenceProperty(em, property);
      const update = { ...invalidateReview(), version: listing.version + 1, updatedAt: new Date() };
      if (
        (await em.nativeUpdate(
          Listing,
          {
            _id: id,
            publisherId: ownerId,
            version: listing.version
          },
          update
        )) !== 1
      )
        throw new PersistenceConflict();
      Object.assign(listing, update);
      return this.response(em, listing, gallery);
    });
  }

  private async deliverable(id: ObjectId, mediaId: ObjectId, ownerId: ObjectId | null) {
    const em = this.orm.em.fork();
    const listing = await em.findOne(Listing, { _id: id, deletedAt: null });
    if (!listing) throw new NotFoundException();
    const owner = await em.findOne(User, {
      _id: listing.publisherId,
      status: 'active',
      deletedAt: null
    });
    if (!owner || (ownerId && !listing.publisherId.equals(ownerId))) throw new NotFoundException();
    if (!ownerId && !(await this.policy.publiclyEligible(listing, owner)))
      throw new NotFoundException();
    const gallery = await em.findOne(MediaGallery, { listingId: id, ownerId: listing.publisherId });
    if (!gallery?.mediaIds.includes(mediaId.toHexString())) throw new NotFoundException();
    const asset = await em.findOne(MediaAsset, {
      _id: mediaId,
      listingId: id,
      ownerId: listing.publisherId,
      state: 'ready'
    });
    if (!asset?.variants) throw new NotFoundException();
    return { asset, listing };
  }

  async image(
    id: ObjectId,
    mediaId: ObjectId,
    name: 'large' | 'thumbnail',
    ownerId: ObjectId | null
  ) {
    const { asset, listing } = await this.deliverable(id, mediaId, ownerId);
    const variant = asset.variants![name];
    const body = await this.storage.read(variant.key, MAX_IMAGE_BYTES);
    const current = await this.deliverable(id, mediaId, ownerId);
    if (
      current.listing.version !== listing.version ||
      current.asset.variants?.[name].key !== variant.key
    )
      throw new NotFoundException();
    return body;
  }
}
