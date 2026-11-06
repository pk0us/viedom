const id = { bsonType: 'objectId' };
const date = { bsonType: 'date' };
const nullableDate = { bsonType: ['date', 'null'] };
const text = (maxLength: number) => ({ bsonType: 'string', minLength: 1, maxLength });
const numeric = (minimum: number, maximum: number) => ({
  bsonType: ['int', 'long', 'double'],
  minimum,
  maximum,
  multipleOf: 1
});
const object = (properties: Record<string, unknown>) => ({
  bsonType: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties
});
const mediaId = { bsonType: 'string', pattern: '^[a-f0-9]{24}$' };
const base = {
  _id: id,
  version: numeric(1, Number.MAX_SAFE_INTEGER),
  createdAt: date,
  updatedAt: date,
  listingId: id,
  ownerId: id
};
const variant = object({
  key: text(512),
  width: numeric(1, 1920),
  height: numeric(1, 1920),
  bytes: numeric(1, 10_485_760)
});

export const mediaValidators = {
  media_assets: {
    $jsonSchema: object({
      ...base,
      state: { enum: ['awaiting_upload', 'queued', 'processing', 'ready', 'failed', 'deleted'] },
      originalKey: text(512),
      contentType: { enum: ['image/jpeg', 'image/png', 'image/webp'] },
      expectedBytes: numeric(1, 10_485_760),
      uploadExpiresAt: date,
      attempts: numeric(0, 5),
      availableAt: date,
      leaseToken: { bsonType: ['string', 'null'], maxLength: 64 },
      leaseUntil: nullableDate,
      processingKeys: { bsonType: 'array', maxItems: 10, uniqueItems: true, items: text(512) },
      variants: { anyOf: [{ bsonType: 'null' }, object({ large: variant, thumbnail: variant })] },
      errorCode: { enum: [null, 'invalid_image', 'processing_failed'] },
      cleanupAt: nullableDate,
      cleanedAt: nullableDate
    })
  },
  media_galleries: {
    $jsonSchema: object({
      ...base,
      mediaIds: { bsonType: 'array', maxItems: 20, uniqueItems: true, items: mediaId },
      coverMediaId: { anyOf: [{ bsonType: 'null' }, mediaId] }
    })
  }
};
