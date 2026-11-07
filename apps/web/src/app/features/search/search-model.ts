import type { ParamMap } from '@angular/router';
import type { ListingMarkersQuery, ListingSearchFilters, SearchBounds } from '@viedom/contracts';
import { publicConfig } from '../../../generated/public-config';

export interface FilterDraft {
  transactionType: string;
  propertyType: string;
  minPrice: string;
  maxPrice: string;
  minBedrooms: string;
  minAreaM2: string;
}

export const emptyFilters = (): FilterDraft => ({
  transactionType: '',
  propertyType: '',
  minPrice: '',
  maxPrice: '',
  minBedrooms: '',
  minAreaM2: ''
});

export function initialBounds(): SearchBounds {
  const { longitude, latitude, zoom } = publicConfig.map;
  const half = Math.min(0.4, 180 / 2 ** zoom);
  const west = Math.max(-180, Math.min(180 - half * 2, longitude - half));
  const south = Math.max(-85, Math.min(85 - half * 2, latitude - half));
  return roundBounds({ west, south, east: west + half * 2, north: south + half * 2 });
}

export function roundBounds(bounds: SearchBounds): SearchBounds {
  return Object.fromEntries(
    Object.entries(bounds).map(([key, value]) => [key, Number(value.toFixed(6))])
  ) as unknown as SearchBounds;
}

export function validBounds(bounds: SearchBounds): boolean {
  return (
    [bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite) &&
    bounds.west >= -180 &&
    bounds.east <= 180 &&
    bounds.south >= -90 &&
    bounds.north <= 90 &&
    bounds.east > bounds.west &&
    bounds.north > bounds.south &&
    bounds.east - bounds.west <= 1 &&
    bounds.north - bounds.south <= 1
  );
}

export function readFilters(draft: FilterDraft): {
  filters: ListingSearchFilters;
  errors: Partial<Record<keyof FilterDraft, string>>;
} {
  const errors: Partial<Record<keyof FilterDraft, string>> = {};
  const filters: ListingSearchFilters = {};
  if (draft.transactionType === 'rent' || draft.transactionType === 'sale')
    filters.transactionType = draft.transactionType;
  else if (draft.transactionType) errors.transactionType = 'Choose rent, sale or either.';
  if (
    draft.propertyType === 'apartment' ||
    draft.propertyType === 'house' ||
    draft.propertyType === 'studio'
  )
    filters.propertyType = draft.propertyType;
  else if (draft.propertyType) errors.propertyType = 'Choose a supported property type.';
  for (const key of ['minPrice', 'maxPrice', 'minBedrooms', 'minAreaM2'] as const) {
    const raw = draft[key].trim();
    if (!raw) continue;
    const price = key === 'minPrice' || key === 'maxPrice';
    const pattern = price
      ? /^\d+(?:\.\d{1,2})?$/
      : key === 'minBedrooms'
        ? /^\d+$/
        : /^\d+(?:\.\d+)?$/;
    const value = price ? Math.round(Number(raw) * 100) : Number(raw);
    const maximum = price ? 100_000_000_000 : key === 'minBedrooms' ? 100 : 100_000;
    if (
      !pattern.test(raw) ||
      !Number.isFinite(value) ||
      value < (key === 'minAreaM2' ? 1 : 0) ||
      value > maximum
    ) {
      errors[key] = price
        ? 'Enter a price from €0 to €1,000,000,000 with at most two decimal places.'
        : key === 'minBedrooms'
          ? 'Enter a whole number from 0 to 100.'
          : 'Enter an area from 1 to 100,000 m².';
    } else filters[key] = value;
  }
  if (
    filters.minPrice !== undefined &&
    filters.maxPrice !== undefined &&
    filters.minPrice > filters.maxPrice
  )
    errors.maxPrice = 'Maximum price must be at least the minimum price.';
  return { filters, errors };
}

export function filterDraft(filters: ListingSearchFilters): FilterDraft {
  return {
    transactionType: filters.transactionType ?? '',
    propertyType: filters.propertyType ?? '',
    minPrice: filters.minPrice === undefined ? '' : String(filters.minPrice / 100),
    maxPrice: filters.maxPrice === undefined ? '' : String(filters.maxPrice / 100),
    minBedrooms: filters.minBedrooms === undefined ? '' : String(filters.minBedrooms),
    minAreaM2: filters.minAreaM2 === undefined ? '' : String(filters.minAreaM2)
  };
}

export function queryParams(query: ListingMarkersQuery): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, String(value)])
  );
}

export function readSearchUrl(params: ParamMap): { query: ListingMarkersQuery; repaired: boolean } {
  let repaired = false;
  let bounds = initialBounds();
  const keys = ['west', 'south', 'east', 'north'] as const;
  if (keys.some((key) => params.has(key))) {
    const parsed = Object.fromEntries(
      keys.map((key) => {
        const value = params.get(key);
        return [
          key,
          value !== null && /^-?\d+(?:\.\d+)?$/.test(value) && params.getAll(key).length === 1
            ? Number(value)
            : NaN
        ];
      })
    ) as unknown as SearchBounds;
    if (validBounds(parsed)) bounds = roundBounds(parsed);
    else repaired = true;
  }
  const draft = emptyFilters();
  for (const key of Object.keys(draft) as (keyof FilterDraft)[]) {
    const raw = params.get(key);
    if (raw === null) continue;
    if (params.getAll(key).length !== 1 || raw.length > 40 || !raw.trim()) {
      repaired = true;
      continue;
    }
    if (key === 'minPrice' || key === 'maxPrice') {
      if (!/^\d+$/.test(raw)) {
        repaired = true;
        continue;
      }
      draft[key] = String(Number(raw) / 100);
    } else draft[key] = raw;
  }
  const { filters, errors } = readFilters(draft);
  for (const key of Object.keys(errors) as (keyof FilterDraft)[]) {
    delete filters[key];
    repaired = true;
  }
  return { query: { ...bounds, ...filters }, repaired };
}
