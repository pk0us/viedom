import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import type { MediaVariant, OwnerListingPreview } from '@viedom/contracts';
import { Configuration } from '../configuration.js';
import { Listing, Property, User } from '../database/entities.js';
import { MediaAsset, MediaGallery } from '../media/media.entities.js';
import { processedMedia } from './listings.policy.js';
import { ListingsService } from './listings.service.js';

@Injectable()
export class ListingsPreviewService {
  constructor(
    private readonly orm: MikroORM,
    private readonly listings: ListingsService,
    private readonly configuration: Configuration
  ) {}

  async read(ownerId: ObjectId, id: ObjectId): Promise<OwnerListingPreview> {
    const detail = await this.listings.read(ownerId, id);
    if (detail.propertyVersion !== detail.property.version) throw new ConflictException();
    const em = this.orm.em.fork();
    const gallery = await em.findOne(MediaGallery, { listingId: id, ownerId });
    const ids = gallery?.mediaIds.filter((value) => /^[a-f0-9]{24}$/.test(value)) ?? [];
    const assets = ids.length
      ? await em.find(MediaAsset, {
          _id: { $in: ids.map((value) => new ObjectId(value)) },
          listingId: id,
          ownerId,
          state: 'ready'
        })
      : [];
    const index = new Map(
      assets.filter(processedMedia).map((asset) => [asset._id.toHexString(), asset])
    );
    const items = ids.flatMap((mediaId) => {
      const asset = index.get(mediaId);
      if (!asset?.variants) return [];
      const variant = (name: 'large' | 'thumbnail'): MediaVariant => {
        const stored = asset.variants![name];
        return {
          url: `${this.configuration.values.public.apiBaseUrl}/listings/${detail.id}/media/${mediaId}/${name}`,
          width: stored.width,
          height: stored.height,
          bytes: stored.bytes,
          contentType: 'image/webp'
        };
      };
      return [
        { id: mediaId, variants: { large: variant('large'), thumbnail: variant('thumbnail') } }
      ];
    });
    const current = this.orm.em.fork();
    if (!(await current.findOne(User, { _id: ownerId, status: 'active', deletedAt: null })))
      throw new ForbiddenException();
    if (
      !(await current.findOne(Listing, {
        _id: id,
        publisherId: ownerId,
        deletedAt: null,
        version: detail.version
      })) ||
      !(await current.findOne(Property, {
        _id: new ObjectId(detail.property.id),
        ownerId,
        version: detail.property.version
      }))
    )
      throw new ConflictException();
    const property = detail.property;
    return {
      version: detail.version,
      status: detail.status,
      submission: detail.submission,
      content: {
        transactionType: detail.transactionType,
        title: detail.title,
        description: detail.description,
        priceMinor: detail.priceMinor,
        currency: detail.currency,
        property: {
          type: property.type,
          details: {
            areaM2: property.details.areaM2,
            bedrooms: property.details.bedrooms,
            bathrooms: property.details.bathrooms,
            floor: property.details.floor,
            yearBuilt: property.details.yearBuilt,
            amenities: [...property.details.amenities]
          },
          address: {
            countryCode: property.address.countryCode,
            city: property.address.city,
            neighborhood: property.address.neighborhood
          },
          publicLocation: {
            type: 'Point',
            coordinates: [...property.publicLocation.coordinates]
          }
        },
        media: {
          coverMediaId: items.some((item) => item.id === gallery?.coverMediaId)
            ? gallery!.coverMediaId
            : null,
          items
        }
      }
    };
  }
}
