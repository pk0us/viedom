import {
  draftFromDetail,
  emptyDraft,
  listingContent,
  priceMinor,
  propertyContent
} from './listing-editor-model';
import type { OwnerListingDetail } from '@viedom/contracts';

describe('draft transport conversion', () => {
  it('preserves cents without rounding invalid precision or accepting exponent syntax', () => {
    expect(priceMinor('850.29')).toBe(85029);
    expect(priceMinor('0.01')).toBe(1);
    expect(priceMinor('1000000000.00')).toBe(100_000_000_000);
    for (const value of ['', '0', '-1', '1e3', '1.001', 'NaN', '1000000000.01'])
      expect(priceMinor(value)).toBeNull();
  });
  it('keeps coordinates ordered longitude/latitude, optional year null, and trims content', () => {
    const model = {
      ...emptyDraft(),
      area: '75.5',
      bedrooms: '2',
      bathrooms: '1',
      floor: '-1',
      longitude: '22.95',
      latitude: '40.65',
      amenities: ['Heating, central', 'balcony\ncovered'],
      city: ' Thessaloniki ',
      price: '850.29',
      title: ' A flat '
    };
    const property = propertyContent(model);
    expect(property.privateLocation.coordinates).toEqual([22.95, 40.65]);
    expect(property.details).toEqual({
      areaM2: 75.5,
      bedrooms: 2,
      bathrooms: 1,
      floor: -1,
      yearBuilt: null,
      amenities: ['Heating, central', 'balcony\ncovered']
    });
    expect(property.address.city).toBe('Thessaloniki');
    expect(listingContent(model)).toMatchObject({
      priceMinor: 85029,
      title: 'A flat',
      currency: 'EUR'
    });
    const detail = { ...listingContent(model), property } as OwnerListingDetail;
    expect(draftFromDetail(detail)).toMatchObject({
      price: '850.29',
      longitude: '22.95',
      latitude: '40.65',
      year: '',
      amenities: model.amenities
    });
  });
});
