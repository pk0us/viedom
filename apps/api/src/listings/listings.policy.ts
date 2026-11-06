import { Injectable } from '@nestjs/common';
import type { SubmissionRequirement } from '@viedom/contracts';
import type { Listing, Property, User } from '../database/entities.js';

@Injectable()
export class ListingMediaPolicy {
  ready: (listing: Listing) => Promise<boolean> = async () => false;
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
