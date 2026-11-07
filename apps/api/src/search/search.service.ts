import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { createHash } from 'node:crypto';
import type {
  ListingMarkersQuery,
  ListingMarkersResponse,
  ListingSearchQuery,
  ListingSearchResponse,
  PublicListingCard,
  PublicListingMarker
} from '@viedom/contracts';
import { Configuration } from '../configuration.js';
import { Listing } from '../database/entities.js';

export const MARKER_LIMIT = 500;
export const SEARCH_MAX_TIME_MS = 2000;
type PipelineStage = Record<string, unknown>;

export function validateSearchBounds(query: ListingMarkersQuery): void {
  if (
    ![query.west, query.south, query.east, query.north].every(Number.isFinite) ||
    query.west < -180 ||
    query.east > 180 ||
    query.south < -90 ||
    query.north > 90 ||
    query.west >= query.east ||
    query.south >= query.north ||
    query.east - query.west > 1 ||
    query.north - query.south > 1 ||
    (query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice)
  )
    throw new BadRequestException(
      'Invalid search bounds or price range. Zoom in to an area at most one degree wide and high.'
    );
}

export function searchFingerprint(query: ListingMarkersQuery): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        query.west,
        query.south,
        query.east,
        query.north,
        query.transactionType ?? null,
        query.minPrice ?? null,
        query.maxPrice ?? null,
        query.minBedrooms ?? null,
        query.minAreaM2 ?? null,
        query.propertyType ?? null
      ])
    )
    .digest('base64url');
}

export function decodeSearchCursor(
  value: string,
  query: ListingMarkersQuery
): { date: Date; id: ObjectId } {
  try {
    if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const text = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(text).toString('base64url') !== value) throw new Error();
    const data: unknown = JSON.parse(text);
    if (
      !Array.isArray(data) ||
      data.length !== 3 ||
      typeof data[0] !== 'string' ||
      typeof data[1] !== 'string' ||
      !/^[a-f0-9]{24}$/.test(data[1]) ||
      data[2] !== searchFingerprint(query)
    )
      throw new Error();
    const date = new Date(data[0]);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== data[0]) throw new Error();
    return { date, id: new ObjectId(data[1]) };
  } catch {
    throw new BadRequestException('Invalid search cursor.');
  }
}

function sphericalBounds(query: ListingMarkersQuery) {
  const longitude = (query.west + query.east) / 2;
  const latitude = (query.south + query.north) / 2;
  const radians = Math.PI / 180;
  const distance = (x: number, y: number) => {
    const a =
      Math.sin(((y - latitude) * radians) / 2) ** 2 +
      Math.cos(latitude * radians) *
        Math.cos(y * radians) *
        Math.sin(((x - longitude) * radians) / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
  };
  const radius =
    Math.max(
      distance(query.west, query.south),
      distance(query.west, query.north),
      distance(query.east, query.south),
      distance(query.east, query.north)
    ) + 1e-9;
  return { $geoWithin: { $centerSphere: [[longitude, latitude], radius] } };
}

function gridCoordinate(axis: number, step: number, maximum: number): unknown {
  return {
    $max: [
      -maximum,
      {
        $min: [
          maximum,
          {
            $round: [
              {
                $multiply: [
                  {
                    $add: [
                      {
                        $floor: {
                          $divide: [
                            { $arrayElemAt: ['$property.privateLocation.coordinates', axis] },
                            step
                          ]
                        }
                      },
                      0.5
                    ]
                  },
                  step
                ]
              },
              7
            ]
          }
        ]
      }
    ]
  };
}

function validVariant(name: 'large' | 'thumbnail'): unknown[] {
  const path = `$$asset.variants.${name}`;
  return [
    { $in: [`${path}.key`, '$$asset.processingKeys'] },
    ...(['bytes', 'width', 'height'] as const).flatMap((field) => [
      { $isNumber: `${path}.${field}` },
      { $gt: [`${path}.${field}`, 0] },
      { $lte: [`${path}.${field}`, field === 'bytes' ? 10_485_760 : 1920] },
      { $eq: [`${path}.${field}`, { $trunc: `${path}.${field}` }] }
    ])
  ];
}

export function buildSearchPipeline(
  query: ListingSearchQuery,
  now = new Date(),
  mode: 'cards' | 'markers' = 'cards'
): PipelineStage[] {
  validateSearchBounds(query);
  const match: Record<string, unknown> = {
    publicLocation: sphericalBounds(query),
    status: 'published',
    deletedAt: null,
    moderationHold: false,
    publishedAt: { $ne: null, $lte: now },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    'publicLocation.coordinates.0': { $gte: query.west, $lte: query.east },
    'publicLocation.coordinates.1': { $gte: query.south, $lte: query.north },
    $expr: {
      $and: [
        { $eq: ['$approvedVersion', '$version'] },
        { $ne: ['$submittedVersion', null] },
        { $lte: ['$submittedVersion', '$version'] },
        { $ne: ['$reviewedById', null] },
        { $ne: ['$reviewedById', '$publisherId'] }
      ]
    }
  };
  if (query.transactionType !== undefined) match['transactionType'] = query.transactionType;
  if (query.propertyType !== undefined) match['propertyType'] = query.propertyType;
  if (query.minBedrooms !== undefined) match['bedrooms'] = { $gte: query.minBedrooms };
  if (query.minAreaM2 !== undefined) match['areaM2'] = { $gte: query.minAreaM2 };
  if (query.minPrice !== undefined || query.maxPrice !== undefined)
    match['priceMinor'] = {
      ...(query.minPrice !== undefined ? { $gte: query.minPrice } : {}),
      ...(query.maxPrice !== undefined ? { $lte: query.maxPrice } : {})
    };
  if (mode === 'cards' && query.cursor !== undefined) {
    const cursor = decodeSearchCursor(query.cursor, query);
    match['$and'] = [
      {
        $or: [
          { publishedAt: { $lt: cursor.date } },
          { publishedAt: cursor.date, _id: { $lt: cursor.id } }
        ]
      }
    ];
  }
  const snapshots = [
    ['$propertyVersion', '$property.version'],
    ['$propertyType', '$property.type'],
    ['$areaM2', '$property.details.areaM2'],
    ['$bedrooms', '$property.details.bedrooms'],
    ['$bathrooms', '$property.details.bathrooms'],
    ['$city', '$property.address.city'],
    ['$neighborhood', '$property.address.neighborhood'],
    ['$publisherId', '$property.ownerId']
  ];
  const latitudeStep = 300 / 111_320;
  const longitudeStep = 300 / (111_320 * Math.cos((40.64 * Math.PI) / 180));
  const baseProjection = {
    _id: 0,
    id: { $toString: '$_id' },
    transactionType: 1,
    priceMinor: 1,
    currency: 1,
    publicLocation: { type: '$publicLocation.type', coordinates: '$publicLocation.coordinates' },
    locationPrecision: { $literal: 'approximate' }
  };
  return [
    { $match: match },
    { $sort: { publishedAt: -1, _id: -1 } },
    {
      $lookup: {
        from: 'users',
        localField: 'publisherId',
        foreignField: '_id',
        as: 'publisher'
      }
    },
    { $unwind: '$publisher' },
    {
      $match: {
        'publisher.status': 'active',
        'publisher.deletedAt': null,
        'publisher.emailVerifiedAt': { $ne: null }
      }
    },
    {
      $lookup: { from: 'properties', localField: 'propertyId', foreignField: '_id', as: 'property' }
    },
    { $unwind: '$property' },
    {
      $match: {
        $expr: {
          $and: [
            ...snapshots.map((pair) => ({ $eq: pair })),
            { $eq: ['$publicLocation.type', 'Point'] },
            {
              $eq: [
                { $arrayElemAt: ['$publicLocation.coordinates', 0] },
                gridCoordinate(0, longitudeStep, 180)
              ]
            },
            {
              $eq: [
                { $arrayElemAt: ['$publicLocation.coordinates', 1] },
                gridCoordinate(1, latitudeStep, 90)
              ]
            }
          ]
        }
      }
    },
    {
      $lookup: {
        from: 'media_galleries',
        localField: '_id',
        foreignField: 'listingId',
        as: 'gallery'
      }
    },
    { $unwind: '$gallery' },
    {
      $match: {
        $expr: {
          $and: [
            { $eq: ['$publisherId', '$gallery.ownerId'] },
            { $gt: [{ $size: '$gallery.mediaIds' }, 0] },
            { $lte: [{ $size: '$gallery.mediaIds' }, 20] },
            {
              $eq: [
                { $size: '$gallery.mediaIds' },
                { $size: { $setUnion: ['$gallery.mediaIds', []] } }
              ]
            },
            { $in: ['$gallery.coverMediaId', '$gallery.mediaIds'] }
          ]
        }
      }
    },
    {
      $set: {
        galleryAssetIds: {
          $map: {
            input: '$gallery.mediaIds',
            as: 'id',
            in: { $convert: { input: '$$id', to: 'objectId', onError: null, onNull: null } }
          }
        }
      }
    },
    {
      $lookup: {
        from: 'media_assets',
        localField: 'galleryAssetIds',
        foreignField: '_id',
        as: 'assets'
      }
    },
    {
      $match: {
        $expr: {
          $and: [
            { $eq: [{ $size: '$assets' }, { $size: '$gallery.mediaIds' }] },
            {
              $allElementsTrue: [
                {
                  $map: {
                    input: '$assets',
                    as: 'asset',
                    in: {
                      $and: [
                        { $eq: ['$$asset.ownerId', '$publisherId'] },
                        { $eq: ['$$asset.listingId', '$_id'] },
                        { $eq: ['$$asset.state', 'ready'] },
                        { $ne: ['$$asset.variants', null] },
                        ...validVariant('large'),
                        ...validVariant('thumbnail')
                      ]
                    }
                  }
                }
              ]
            }
          ]
        }
      }
    },
    { $limit: (mode === 'cards' ? (query.limit ?? 20) : MARKER_LIMIT) + 1 },
    ...(mode === 'cards'
      ? [
          {
            $set: {
              cover: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: '$assets',
                      as: 'asset',
                      cond: {
                        $eq: [{ $toString: '$$asset._id' }, '$gallery.coverMediaId']
                      }
                    }
                  },
                  0
                ]
              }
            }
          },
          {
            $project: {
              ...baseProjection,
              title: 1,
              slug: 1,
              propertyType: 1,
              areaM2: 1,
              bedrooms: 1,
              bathrooms: 1,
              city: 1,
              neighborhood: 1,
              publishedAt: 1,
              coverMediaId: '$gallery.coverMediaId',
              coverDimensions: {
                width: '$cover.variants.thumbnail.width',
                height: '$cover.variants.thumbnail.height',
                bytes: '$cover.variants.thumbnail.bytes'
              }
            }
          }
        ]
      : [{ $project: baseProjection }])
  ];
}

interface SearchCardRow extends Omit<PublicListingCard, 'publishedAt' | 'coverImage'> {
  publishedAt: Date;
  coverMediaId: string;
  coverDimensions: { width: number; height: number; bytes: number };
}

@Injectable()
export class SearchService {
  constructor(
    private readonly orm: MikroORM,
    private readonly configuration: Configuration
  ) {}

  async search(query: ListingSearchQuery): Promise<ListingSearchResponse> {
    const limit = query.limit ?? 20;
    const rows = await this.execute<SearchCardRow>(buildSearchPipeline(query));
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => ({
        ...marker(row),
        title: row.title,
        slug: row.slug,
        propertyType: row.propertyType,
        areaM2: row.areaM2,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        city: row.city,
        neighborhood: row.neighborhood,
        publishedAt: row.publishedAt.toISOString(),
        coverImage: {
          url: `${this.configuration.values.storage.deliveryBaseUrl}/${row.id}/${row.coverMediaId}/thumbnail`,
          width: row.coverDimensions.width,
          height: row.coverDimensions.height,
          bytes: row.coverDimensions.bytes,
          contentType: 'image/webp'
        }
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify([last.publishedAt.toISOString(), last.id, searchFingerprint(query)])
            ).toString('base64url')
          : null
    };
  }

  async markers(query: ListingMarkersQuery): Promise<ListingMarkersResponse> {
    const rows = await this.execute<PublicListingMarker>(
      buildSearchPipeline(query, new Date(), 'markers')
    );
    return {
      items: rows.slice(0, MARKER_LIMIT).map(marker),
      capped: rows.length > MARKER_LIMIT,
      limit: MARKER_LIMIT
    };
  }

  private async execute<T extends object>(pipeline: PipelineStage[]): Promise<T[]> {
    try {
      return await this.orm.em
        .fork()
        .getCollection(Listing)
        .aggregate<T>(pipeline, {
          hint: 'public_search_geo',
          maxTimeMS: SEARCH_MAX_TIME_MS,
          allowDiskUse: false
        })
        .toArray();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 50)
        throw new ServiceUnavailableException('Search took too long. Try a smaller area.');
      throw error;
    }
  }
}

function marker(row: PublicListingMarker): PublicListingMarker {
  return {
    id: row.id,
    transactionType: row.transactionType,
    priceMinor: row.priceMinor,
    currency: row.currency,
    publicLocation: { type: 'Point', coordinates: [...row.publicLocation.coordinates] },
    locationPrecision: 'approximate'
  };
}
