import type { Listing } from './entities.js';
import type { GeoPoint, PropertyType } from './domain.js';

/** Server-local projection foundation, not a published endpoint/eligibility decision. */
export interface PublicListingSummary {
  id: string;
  title: string;
  slug: string;
  transactionType: 'rent' | 'sale';
  priceMinor: number;
  currency: 'EUR';
  propertyType: PropertyType;
  areaM2: number;
  bedrooms: number;
  city: string;
  neighborhood: string;
  publicLocation: GeoPoint;
  locationPrecision: 'approximate';
}

/** Allowlist only. Never spread/serialize entities; preview can reuse this projection later. */
export function publicListingSummary(listing: Listing): PublicListingSummary {
  return {
    id: listing._id.toHexString(),
    title: listing.title,
    slug: listing.slug,
    transactionType: listing.transactionType,
    priceMinor: listing.priceMinor,
    currency: listing.currency,
    propertyType: listing.propertyType,
    areaM2: listing.areaM2,
    bedrooms: listing.bedrooms,
    city: listing.city,
    neighborhood: listing.neighborhood,
    publicLocation: { type: 'Point', coordinates: [...listing.publicLocation.coordinates] },
    locationPrecision: 'approximate'
  };
}
