import { convertToParamMap } from '@angular/router';
import {
  filterDraft,
  initialBounds,
  readFilters,
  readSearchUrl,
  validBounds
} from './search-model';

describe('public search state validation', () => {
  it('preserves exact cents, zero and decimal area', () => {
    const result = readFilters({
      transactionType: 'rent',
      propertyType: 'house',
      minPrice: '0',
      maxPrice: '1234.56',
      minBedrooms: '0',
      minAreaM2: '25.5'
    });
    expect(result.errors).toEqual({});
    expect(result.filters).toEqual({
      transactionType: 'rent',
      propertyType: 'house',
      minPrice: 0,
      maxPrice: 123456,
      minBedrooms: 0,
      minAreaM2: 25.5
    });
    expect(readFilters(filterDraft(result.filters))).toEqual(result);
  });

  it('rejects invalid numbers and crossed prices before requests', () => {
    expect(
      readFilters({
        transactionType: '',
        propertyType: '',
        minPrice: '1200',
        maxPrice: '100',
        minBedrooms: '1.5',
        minAreaM2: '1e4'
      }).errors
    ).toMatchObject({
      maxPrice: expect.any(String),
      minBedrooms: expect.any(String),
      minAreaM2: expect.any(String)
    });
    for (const value of ['-1', 'NaN', 'Infinity', '1e2', '0.001', '1000000001']) {
      expect(readFilters({ ...filterDraft({}), minPrice: value }).errors.minPrice).toBeTruthy();
    }
  });

  it('restores only scalar valid query state and interprets URL prices as cents', () => {
    const valid = readSearchUrl(
      convertToParamMap({
        west: '22.8',
        south: '40.5',
        east: '23',
        north: '40.7',
        maxPrice: '123456',
        propertyType: 'studio'
      })
    );
    expect(valid.repaired).toBe(false);
    expect(valid.query).toMatchObject({ maxPrice: 123456, propertyType: 'studio', west: 22.8 });
    const invalid = readSearchUrl(
      convertToParamMap({
        west: ['22', '23'],
        north: '90',
        minPrice: 'Infinity',
        minBedrooms: ['1', '2'],
        propertyType: 'other'
      })
    );
    expect(invalid.repaired).toBe(true);
    expect(invalid.query).toEqual(initialBounds());
  });

  it('blocks oversized, antimeridian and inverted views', () => {
    expect(validBounds(initialBounds())).toBe(true);
    expect(validBounds({ west: 179.8, south: 10, east: -179.8, north: 10.5 })).toBe(false);
    expect(validBounds({ west: 22, south: 40, east: 24, north: 41 })).toBe(false);
    expect(validBounds({ west: 22, south: 41, east: 22.5, north: 40 })).toBe(false);
  });
});
