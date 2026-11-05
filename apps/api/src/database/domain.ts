/** Server-only domain values. Transport contracts remain independent. */
export const propertyTypes = ['apartment', 'house', 'studio'] as const;
export const listingStates = [
  'draft',
  'pending_review',
  'rejected',
  'published',
  'paused',
  'archived'
] as const;
export type PropertyType = (typeof propertyTypes)[number];
export type ListingState = (typeof listingStates)[number];
export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number];
}
export interface PropertyDetails {
  areaM2: number;
  bedrooms: number;
  bathrooms: number;
  floor: number;
  yearBuilt: number | null;
  amenities: string[];
}
export interface PropertyAddress {
  countryCode: 'GR';
  city: string;
  neighborhood: string;
  street: string;
}
export interface PropertyContent {
  type: PropertyType;
  details: PropertyDetails;
  address: PropertyAddress;
  privateLocation: GeoPoint;
}

export function requireValue(valid: boolean, field: string): asserts valid {
  if (!valid) throw new Error(`Invalid domain field: ${field}.`);
}
export function text(value: unknown, field: string, min: number, max: number): void {
  requireValue(typeof value === 'string' && value.length >= min && value.length <= max, field);
}
export function number(
  value: number,
  field: string,
  min: number,
  max: number,
  integer = false
): void {
  requireValue(
    Number.isFinite(value) &&
      value >= min &&
      value <= max &&
      (!integer || Number.isSafeInteger(value)),
    field
  );
}
export function validatePoint(point: GeoPoint): void {
  requireValue(
    point?.type === 'Point' && Array.isArray(point.coordinates) && point.coordinates.length === 2,
    'location'
  );
  number(point.coordinates[0], 'longitude', -180, 180);
  number(point.coordinates[1], 'latitude', -90, 90);
}

/** Fixed 300m grid near Thessaloniki (40.64N); stable cell centre, never response jitter. */
export function approximateLocation(point: GeoPoint): GeoPoint {
  validatePoint(point);
  const latitudeStep = 300 / 111_320;
  const longitudeStep = 300 / (111_320 * Math.cos((40.64 * Math.PI) / 180));
  const centre = (value: number, step: number, max: number) =>
    Math.max(-max, Math.min(max, Number(((Math.floor(value / step) + 0.5) * step).toFixed(7))));
  return {
    type: 'Point',
    coordinates: [
      centre(point.coordinates[0], longitudeStep, 180),
      centre(point.coordinates[1], latitudeStep, 90)
    ]
  };
}

export function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  requireValue(
    normalized.length <= 254 &&
      /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(
        normalized
      ),
    'email'
  );
  return normalized;
}

export function validateProperty(content: PropertyContent): void {
  requireValue(propertyTypes.includes(content.type), 'type');
  const d = content.details;
  number(d.areaM2, 'areaM2', 1, 100_000);
  number(d.bedrooms, 'bedrooms', 0, 100, true);
  number(d.bathrooms, 'bathrooms', 0, 100, true);
  number(d.floor, 'floor', -10, 200, true);
  if (d.yearBuilt !== null) number(d.yearBuilt, 'yearBuilt', 1800, 2100, true);
  requireValue(
    Array.isArray(d.amenities) &&
      d.amenities.length <= 30 &&
      new Set(d.amenities).size === d.amenities.length,
    'amenities'
  );
  d.amenities.forEach((value) => text(value, 'amenity', 1, 50));
  requireValue(content.address.countryCode === 'GR', 'countryCode');
  text(content.address.city, 'city', 1, 100);
  text(content.address.neighborhood, 'neighborhood', 0, 100);
  text(content.address.street, 'street', 0, 200);
  validatePoint(content.privateLocation);
}
