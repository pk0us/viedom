import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { createHash } from 'node:crypto';
import type {
  ListingMarkersQuery,
  ListingMarkersResponse,
  ListingSearchQuery,
  ListingSearchResponse,
  PublicListingCard,
  PublicListingDetail,
  RecentListingsResponse,
  ListingSitemapResponse,
  ListingPreviewContent,
  MediaVariant,
  PublicListingMarker
} from '@viedom/contracts';
import type { PipelineStage } from './public-listings.pipeline.js';
import { Configuration } from '../configuration.js';
import { Listing } from '../database/entities.js';
import {
  buildPublicEligibilityPipeline,
  cardProjectionStages,
  markerProjection
} from './public-listings.pipeline.js';

export const MARKER_LIMIT = 500;
export const RECENT_LIMIT = 6;
export const SITEMAP_LIMIT = 1000;
export const SEARCH_MAX_TIME_MS = 2000;

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

export function buildSearchPipeline(
  query: ListingSearchQuery,
  now = new Date(),
  mode: 'cards' | 'markers' = 'cards'
): PipelineStage[] {
  validateSearchBounds(query);
  const match: Record<string, unknown> = {
    publicLocation: sphericalBounds(query),
    'publicLocation.coordinates.0': { $gte: query.west, $lte: query.east },
    'publicLocation.coordinates.1': { $gte: query.south, $lte: query.north }
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
  return [
    ...buildPublicEligibilityPipeline(match, now),
    { $limit: (mode === 'cards' ? (query.limit ?? 20) : MARKER_LIMIT) + 1 },
    ...(mode === 'cards' ? cardProjectionStages() : [{ $project: markerProjection }])
  ];
}

interface PublicDetailRow {
  id: string;
  slug: string;
  publishedAt: Date;
  content: Omit<ListingPreviewContent, 'media'>;
  coverMediaId: string;
  media: {
    id: string;
    variants: Record<'large' | 'thumbnail', Omit<MediaVariant, 'url' | 'contentType'>>;
  }[];
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
      items: items.map((row) => this.card(row)),
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

  async recent(): Promise<RecentListingsResponse> {
    const rows = await this.execute<SearchCardRow>(
      [
        ...buildPublicEligibilityPipeline({ city: this.configuration.values.public.city }),
        { $limit: RECENT_LIMIT },
        ...cardProjectionStages()
      ],
      'status_published'
    );
    return { items: rows.map((row) => this.card(row)) };
  }

  async detail(id: string): Promise<PublicListingDetail> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new NotFoundException();
    const rows = await this.execute<PublicDetailRow>(
      [
        ...buildPublicEligibilityPipeline({ _id: new ObjectId(id) }),
        { $limit: 1 },
        {
          $project: {
            _id: 0,
            id: { $toString: '$_id' },
            slug: 1,
            publishedAt: 1,
            coverMediaId: '$gallery.coverMediaId',
            content: {
              transactionType: '$transactionType',
              title: '$title',
              description: '$description',
              priceMinor: '$priceMinor',
              currency: '$currency',
              property: {
                type: '$propertyType',
                details: {
                  areaM2: '$areaM2',
                  bedrooms: '$bedrooms',
                  bathrooms: '$bathrooms',
                  floor: '$property.details.floor',
                  yearBuilt: '$property.details.yearBuilt',
                  amenities: '$property.details.amenities'
                },
                address: {
                  countryCode: '$property.address.countryCode',
                  city: '$city',
                  neighborhood: '$neighborhood'
                },
                publicLocation: {
                  type: '$publicLocation.type',
                  coordinates: '$publicLocation.coordinates'
                }
              }
            },
            media: {
              $map: {
                input: '$gallery.mediaIds',
                as: 'id',
                in: {
                  $let: {
                    vars: {
                      asset: {
                        $arrayElemAt: [
                          {
                            $filter: {
                              input: '$assets',
                              as: 'candidate',
                              cond: { $eq: [{ $toString: '$$candidate._id' }, '$$id'] }
                            }
                          },
                          0
                        ]
                      }
                    },
                    in: {
                      id: '$$id',
                      variants: {
                        large: {
                          width: '$$asset.variants.large.width',
                          height: '$$asset.variants.large.height',
                          bytes: '$$asset.variants.large.bytes'
                        },
                        thumbnail: {
                          width: '$$asset.variants.thumbnail.width',
                          height: '$$asset.variants.thumbnail.height',
                          bytes: '$$asset.variants.thumbnail.bytes'
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      ],
      '_id_'
    );
    const row = rows[0];
    if (!row) throw new NotFoundException();
    return {
      id: row.id,
      slug: row.slug,
      publishedAt: row.publishedAt.toISOString(),
      locationPrecision: 'approximate',
      content: {
        ...row.content,
        media: {
          coverMediaId: row.coverMediaId,
          items: row.media.map((item) => {
            const variant = (name: 'large' | 'thumbnail'): MediaVariant => ({
              url: `${this.configuration.values.storage.deliveryBaseUrl}/${row.id}/${item.id}/${name}`,
              width: item.variants[name].width,
              height: item.variants[name].height,
              bytes: item.variants[name].bytes,
              contentType: 'image/webp'
            });
            return {
              id: item.id,
              variants: { large: variant('large'), thumbnail: variant('thumbnail') }
            };
          })
        }
      }
    };
  }

  async sitemap(cursor?: string): Promise<ListingSitemapResponse> {
    const match: Record<string, unknown> = {};
    if (cursor !== undefined) {
      const value = decodeSitemapCursor(cursor);
      match['$and'] = [
        {
          $or: [
            { publishedAt: { $lt: value.date } },
            { publishedAt: value.date, _id: { $lt: value.id } }
          ]
        }
      ];
    }
    const rows = await this.execute<{ id: string; slug: string; publishedAt: Date }>(
      [
        ...buildPublicEligibilityPipeline(match),
        { $limit: SITEMAP_LIMIT + 1 },
        { $project: { _id: 0, id: { $toString: '$_id' }, slug: 1, publishedAt: 1 } }
      ],
      'status_published'
    );
    const items = rows.slice(0, SITEMAP_LIMIT).map((row) => ({
      id: row.id,
      slug: row.slug,
      publishedAt: row.publishedAt.toISOString()
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > SITEMAP_LIMIT && last
          ? Buffer.from(JSON.stringify([last.publishedAt, last.id, 'sitemap'])).toString(
              'base64url'
            )
          : null
    };
  }

  private card(row: SearchCardRow): PublicListingCard {
    return {
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
    };
  }

  private async execute<T extends object>(
    pipeline: PipelineStage[],
    hint = 'public_search_geo'
  ): Promise<T[]> {
    try {
      return await this.orm.em
        .fork()
        .getCollection(Listing)
        .aggregate<T>(pipeline, {
          hint,
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

export function decodeSitemapCursor(value: string): { date: Date; id: ObjectId } {
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
      data[2] !== 'sitemap'
    )
      throw new Error();
    const date = new Date(data[0]);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== data[0]) throw new Error();
    return { date, id: new ObjectId(data[1]) };
  } catch {
    throw new BadRequestException('Invalid sitemap cursor.');
  }
}
