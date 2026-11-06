import { Injectable } from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import type { SubmissionRequirement } from '@viedom/contracts';
import type { Listing, Property, User } from '../database/entities.js';
import { MediaAsset, MediaGallery } from '../media/media.entities.js';

export function processedMedia(asset: MediaAsset): boolean {
  return Boolean(
    asset.state === 'ready' &&
    asset.variants &&
    [asset.variants.large, asset.variants.thumbnail].every(
      (variant) =>
        variant &&
        asset.processingKeys.includes(variant.key) &&
        Number.isSafeInteger(variant.bytes) &&
        variant.bytes > 0 &&
        variant.bytes <= 10_485_760 &&
        Number.isInteger(variant.width) &&
        variant.width > 0 &&
        variant.width <= 1920 &&
        Number.isInteger(variant.height) &&
        variant.height > 0 &&
        variant.height <= 1920
    )
  );
}

@Injectable()
export class ListingMediaPolicy {
  constructor(private readonly orm: MikroORM) {}

  ready: (listing: Listing) => Promise<boolean> = async (listing) => {
    const em = this.orm.em.fork();
    const gallery = await em.findOne(MediaGallery, {
      listingId: listing._id,
      ownerId: listing.publisherId
    });
    if (
      !gallery?.mediaIds.length ||
      gallery.mediaIds.length > 20 ||
      !gallery.coverMediaId ||
      !gallery.mediaIds.includes(gallery.coverMediaId) ||
      new Set(gallery.mediaIds).size !== gallery.mediaIds.length ||
      gallery.mediaIds.some((id) => !/^[a-f0-9]{24}$/.test(id))
    )
      return false;
    const assets = await em.find(MediaAsset, {
      _id: { $in: gallery.mediaIds.map((id) => new ObjectId(id)) },
      listingId: listing._id,
      ownerId: listing.publisherId,
      state: 'ready'
    });
    return assets.length === gallery.mediaIds.length && assets.every(processedMedia);
  };
}

@Injectable()
export class ListingsPolicy {
  constructor(private readonly media: ListingMediaPolicy) {}

  async submission(listing: Listing, property: Property, owner: User) {
    const missing: SubmissionRequirement[] = [];
    if (!owner.emailVerifiedAt) missing.push('verifiedEmail');
    if (listing.title.trim().length < 10) missing.push('title');
    if (listing.description.trim().length < 30) missing.push('description');
    if (property.details.bathrooms < 1) missing.push('bathrooms');
    if (!(await this.media.ready(listing))) missing.push('processedMedia');
    if (listing.moderationHold) missing.push('moderationHold');
    if (!['draft', 'rejected', 'paused'].includes(listing.status) || listing.deletedAt)
      missing.push('state');
    return { canSubmit: missing.length === 0, missing };
  }

  async publiclyEligible(listing: Listing, owner: User | null, now = new Date()): Promise<boolean> {
    return Boolean(
      owner &&
      owner._id.equals(listing.publisherId) &&
      owner.status === 'active' &&
      !owner.deletedAt &&
      owner.emailVerifiedAt &&
      listing.status === 'published' &&
      listing.approvedVersion === listing.version &&
      listing.submittedVersion !== null &&
      listing.submittedVersion <= listing.version &&
      listing.reviewedById &&
      !listing.reviewedById.equals(listing.publisherId) &&
      listing.publishedAt &&
      listing.publishedAt <= now &&
      !listing.deletedAt &&
      !listing.moderationHold &&
      (!listing.expiresAt || listing.expiresAt > now) &&
      (await this.media.ready(listing))
    );
  }
}

export function invalidateReview() {
  return {
    status: 'draft' as const,
    submittedVersion: null,
    approvedVersion: null,
    reviewedById: null,
    publishedAt: null,
    expiresAt: null
  };
}

export function listingSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 200) || 'property'
  );
}
