import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ObjectId } from '@mikro-orm/mongodb';
import { fixtures } from '../database/fixtures.js';
import type { User } from '../database/entities.js';
import { MediaAsset, MediaGallery } from '../media/media.entities.js';
import { moderationDecidable, moderationEligible, moderationReady } from './admin.service.js';
import { PendingListingsQuery, RejectListingDto } from './admin.dto.js';
import { openApiDocument } from '../openapi.js';

function submission() {
  const data = fixtures();
  const listing = data.listings[1]!;
  const property = data.properties[1]!;
  const owner: User = data.users[1]!;
  const asset: MediaAsset = Object.assign(new MediaAsset(), {
    listingId: listing._id,
    ownerId: owner._id,
    state: 'ready' as const,
    processingKeys: ['processed/large.webp', 'processed/thumbnail.webp'],
    variants: {
      large: { key: 'processed/large.webp', width: 1200, height: 900, bytes: 12000 },
      thumbnail: { key: 'processed/thumbnail.webp', width: 400, height: 300, bytes: 4000 }
    }
  });
  const gallery = Object.assign(new MediaGallery(), {
    listingId: listing._id,
    ownerId: owner._id,
    mediaIds: [asset._id.toHexString()],
    coverMediaId: asset._id.toHexString()
  });
  return { listing, property, owner, gallery, asset };
}

it('accepts a complete current canonical submission and both validated derivatives', () => {
  const { listing, property, owner, gallery, asset } = submission();
  expect(moderationEligible(listing, property, owner)).toBe(true);
  expect(moderationReady(listing, property, owner, gallery, [asset])).toBe(true);
});

it.each(['unverified', 'suspended', 'deleted', 'expired', 'canonical', 'snapshot'] as const)(
  'permits rejecting a current %s submission while denying publication',
  (condition) => {
    const { listing, property, owner, gallery, asset } = submission();
    if (condition === 'unverified') owner.emailVerifiedAt = null;
    if (condition === 'suspended') owner.status = 'suspended';
    if (condition === 'deleted') owner.deletedAt = new Date();
    if (condition === 'expired') listing.expiresAt = new Date(0);
    if (condition === 'canonical') property.version++;
    if (condition === 'snapshot') listing.city = 'Stale city';
    expect(moderationDecidable(listing)).toBe(true);
    expect(moderationReady(listing, property, owner, gallery, [asset])).toBe(false);
  }
);

it.each(['draft', 'stale', 'hold', 'deleted'] as const)(
  'denies all decisions for a %s submission',
  (condition) => {
    const { listing, property, owner, gallery, asset } = submission();
    if (condition === 'draft') listing.status = 'draft';
    if (condition === 'stale') listing.submittedVersion = listing.version - 1;
    if (condition === 'hold') listing.moderationHold = true;
    if (condition === 'deleted') listing.deletedAt = new Date();
    expect(moderationDecidable(listing)).toBe(false);
    expect(moderationReady(listing, property, owner, gallery, [asset])).toBe(false);
  }
);

it.each([
  'missing',
  'failed',
  'duplicate',
  'cover',
  'unowned',
  'unprocessed',
  'oversized'
] as const)('requires a valid processed gallery for approval: %s', (condition) => {
  const { listing, property, owner, gallery, asset } = submission();
  if (condition === 'failed') asset.state = 'failed';
  if (condition === 'duplicate') gallery.mediaIds.push(asset._id.toHexString());
  if (condition === 'cover') gallery.coverMediaId = new ObjectId().toHexString();
  if (condition === 'unowned') asset.ownerId = new ObjectId();
  if (condition === 'unprocessed') asset.processingKeys = [];
  if (condition === 'oversized') asset.variants!.large.bytes = 10_485_761;
  expect(moderationDecidable(listing)).toBe(true);
  expect(
    moderationReady(listing, property, owner, condition === 'missing' ? null : gallery, [asset])
  ).toBe(false);
});

it('fails closed on invalid canonical content independently of the denormalized snapshot', () => {
  const { listing, property, owner, gallery, asset } = submission();
  property.privateLocation.coordinates[1] = 150;
  expect(moderationReady(listing, property, owner, gallery, [asset])).toBe(false);
});

it('trims rejection feedback and validates versions, limits and unknown administrative fields', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const reject = { type: 'body' as const, metatype: RejectListingDto };
  const input: RejectListingDto = await pipe.transform(
    { expectedVersion: 2, reason: '  Improve photos.  ' },
    reject
  );
  expect(input.reason).toBe('Improve photos.');
  for (const body of [
    { expectedVersion: 2, reason: '  ' },
    { expectedVersion: 2, reason: 'x'.repeat(2001) },
    { expectedVersion: 2, reason: { $ne: '' } },
    { expectedVersion: 2, reason: 'Reason', reviewerId: new ObjectId().toHexString() },
    { expectedVersion: '2', reason: 'Reason' },
    { expectedVersion: Number.MAX_SAFE_INTEGER, reason: 'Reason' }
  ])
    await expect(pipe.transform(body, reject)).rejects.toBeInstanceOf(BadRequestException);
  const query = { type: 'query' as const, metatype: PendingListingsQuery };
  expect((await pipe.transform({ limit: '50' }, query)).limit).toBe(50);
  for (const limit of ['0', '51', '1.5', '100000'])
    await expect(pipe.transform({ limit }, query)).rejects.toBeInstanceOf(BadRequestException);
});

it('documents private moderation operations with bearer authorization and bounded responses', () => {
  const paths = openApiDocument.paths;
  expect(paths['/admin/listings/pending'].get.security).toEqual([{ bearerAuth: [] }]);
  expect(
    paths['/admin/listings/{id}/approve'].post.requestBody?.content['application/json'].schema
  ).toEqual({ $ref: '#/components/schemas/VersionRequest' });
  expect(
    paths['/admin/listings/{id}/reject'].post.requestBody?.content['application/json'].schema
  ).toEqual({ $ref: '#/components/schemas/RejectListing' });
  expect(openApiDocument.components.schemas.AdminListingDetail.properties.history).toMatchObject({
    maxItems: 20
  });
});
