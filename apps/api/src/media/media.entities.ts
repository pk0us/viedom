import { EntitySchema } from '@mikro-orm/core';
import { ObjectId } from '@mikro-orm/mongodb';
import type { MediaState, UploadContentType } from '@viedom/contracts';

export interface StoredVariant {
  key: string;
  width: number;
  height: number;
  bytes: number;
}

class MediaRecord {
  _id = new ObjectId();
  version = 1;
  createdAt = new Date();
  updatedAt = new Date();

  toJSON(): never {
    throw new Error('Media records require an explicit response mapper.');
  }
}

export class MediaAsset extends MediaRecord {
  listingId!: ObjectId;
  ownerId!: ObjectId;
  state: MediaState = 'awaiting_upload';
  originalKey!: string;
  contentType!: UploadContentType;
  expectedBytes!: number;
  uploadExpiresAt!: Date;
  attempts = 0;
  availableAt = new Date();
  leaseToken: string | null = null;
  leaseUntil: Date | null = null;
  processingKeys: string[] = [];
  variants: { large: StoredVariant; thumbnail: StoredVariant } | null = null;
  errorCode: 'invalid_image' | 'processing_failed' | null = null;
  cleanupAt: Date | null = null;
  cleanedAt: Date | null = null;
}

export class MediaGallery extends MediaRecord {
  listingId!: ObjectId;
  ownerId!: ObjectId;
  mediaIds: string[] = [];
  coverMediaId: string | null = null;
}

const base = {
  _id: { type: 'ObjectId', primary: true, hidden: true },
  version: { type: 'number' },
  createdAt: { type: 'Date' },
  updatedAt: { type: 'Date' },
  listingId: { type: 'ObjectId', hidden: true },
  ownerId: { type: 'ObjectId', hidden: true }
} as const;

export const MediaAssetSchema = new EntitySchema<MediaAsset>({
  class: MediaAsset,
  tableName: 'media_assets',
  properties: {
    ...base,
    state: { type: 'string' },
    originalKey: { type: 'string', hidden: true },
    contentType: { type: 'string' },
    expectedBytes: { type: 'number' },
    uploadExpiresAt: { type: 'Date' },
    attempts: { type: 'number', hidden: true },
    availableAt: { type: 'Date', hidden: true },
    leaseToken: { type: 'string', nullable: true, hidden: true },
    leaseUntil: { type: 'Date', nullable: true, hidden: true },
    processingKeys: { type: 'json', hidden: true },
    variants: { type: 'json', nullable: true, hidden: true },
    errorCode: { type: 'string', nullable: true },
    cleanupAt: { type: 'Date', nullable: true, hidden: true },
    cleanedAt: { type: 'Date', nullable: true, hidden: true }
  }
});

export const MediaGallerySchema = new EntitySchema<MediaGallery>({
  class: MediaGallery,
  tableName: 'media_galleries',
  properties: {
    ...base,
    mediaIds: { type: 'json', hidden: true },
    coverMediaId: { type: 'string', nullable: true, hidden: true }
  }
});
