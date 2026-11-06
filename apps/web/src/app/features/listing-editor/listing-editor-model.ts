import type { ListingContent, OwnerListingDetail, PropertyContent } from '@viedom/contracts';
import { publicConfig } from '../../../generated/public-config';

export function emptyDraft() {
  return {
    type: 'apartment' as PropertyContent['type'],
    area: '',
    bedrooms: '0',
    bathrooms: '0',
    floor: '0',
    year: '',
    amenities: [] as string[],
    city: publicConfig.city,
    neighborhood: '',
    street: '',
    longitude: String(publicConfig.map.longitude),
    latitude: String(publicConfig.map.latitude),
    transaction: 'rent' as ListingContent['transactionType'],
    title: '',
    description: '',
    price: ''
  };
}
export type DraftModel = ReturnType<typeof emptyDraft>;

export function priceMinor(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) && result >= 1 && result <= 100_000_000_000 ? result : null;
}

export function propertyContent(model: DraftModel): PropertyContent {
  return {
    type: model.type,
    details: {
      areaM2: Number(model.area),
      bedrooms: Number(model.bedrooms),
      bathrooms: Number(model.bathrooms),
      floor: Number(model.floor),
      yearBuilt: model.year.trim() ? Number(model.year) : null,
      amenities: [...model.amenities]
    },
    address: {
      countryCode: 'GR',
      city: model.city.trim(),
      neighborhood: model.neighborhood.trim(),
      street: model.street.trim()
    },
    privateLocation: {
      type: 'Point',
      coordinates: [Number(model.longitude), Number(model.latitude)]
    }
  };
}

export function listingContent(model: DraftModel): ListingContent {
  return {
    transactionType: model.transaction,
    title: model.title.trim(),
    description: model.description.trim(),
    priceMinor: priceMinor(model.price) ?? 0,
    currency: 'EUR'
  };
}

export function draftFromDetail(detail: OwnerListingDetail): DraftModel {
  const property = detail.property;
  return {
    type: property.type,
    area: String(property.details.areaM2),
    bedrooms: String(property.details.bedrooms),
    bathrooms: String(property.details.bathrooms),
    floor: String(property.details.floor),
    year: property.details.yearBuilt === null ? '' : String(property.details.yearBuilt),
    amenities: [...property.details.amenities],
    city: property.address.city,
    neighborhood: property.address.neighborhood,
    street: property.address.street,
    longitude: String(property.privateLocation.coordinates[0]),
    latitude: String(property.privateLocation.coordinates[1]),
    transaction: detail.transactionType,
    title: detail.title,
    description: detail.description,
    price: (detail.priceMinor / 100).toFixed(2)
  };
}

export function sameContent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
