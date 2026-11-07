import { BadRequestException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mongodb';
import type { ListingSearchQuery } from '@viedom/contracts';
import { Configuration } from '../configuration.js';
import { ListingMarkersQueryDto, ListingSearchQueryDto } from './search.dto.js';
import {
  buildSearchPipeline,
  decodeSearchCursor,
  SearchService,
  searchFingerprint
} from './search.service.js';

const box: ListingSearchQuery = { west: 22.8, south: 40.5, east: 23, north: 40.7 };
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validate = (value: object, metatype = ListingSearchQueryDto) =>
  pipe.transform(value, { type: 'query', metatype });

describe('search query validation', () => {
  it('accepts finite scalar filters and supplies bounded card defaults', async () => {
    const input = Object.fromEntries(
      Object.entries({ ...box, minPrice: 0, minAreaM2: 1.5 }).map(([key, value]) => [
        key,
        String(value)
      ])
    );
    await expect(validate(input)).resolves.toMatchObject({
      ...box,
      minPrice: 0,
      minAreaM2: 1.5,
      limit: 20
    });
  });

  it.each([
    { west: ['22.8', '22.9'] },
    { minPrice: ['1', '2'] },
    { transactionType: ['rent', 'sale'] },
    { west: '' },
    { west: 'Infinity' },
    { north: '91' },
    { minPrice: '1.5' },
    { limit: '51' },
    { minAreaM2: '0' },
    { unknown: 'value' },
    { cursor: ['one', 'two'] }
  ])('rejects malformed, repeated or unknown fields %j', async (extra) => {
    const input = Object.fromEntries(
      Object.entries(box).map(([key, value]) => [key, String(value)])
    );
    await expect(validate({ ...input, ...extra })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forbids card pagination on markers', async () => {
    const input = Object.fromEntries(
      Object.entries(box).map(([key, value]) => [key, String(value)])
    );
    await expect(
      pipe.transform({ ...input, limit: '20' }, { type: 'query', metatype: ListingMarkersQueryDto })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    { west: 23 },
    { east: 24 },
    { south: 41 },
    { north: 42 },
    { west: 179, east: -179 },
    { west: -180, east: 180 },
    { minPrice: 10, maxPrice: 9 }
  ])('rejects unsupported bounds and price ranges %j', (extra) => {
    expect(() => buildSearchPipeline({ ...box, ...extra })).toThrow(BadRequestException);
  });
});

describe('search cursors', () => {
  const date = '2026-11-07T00:00:00.000Z';
  const id = 'a'.repeat(24);
  const cursor = Buffer.from(JSON.stringify([date, id, searchFingerprint(box)])).toString(
    'base64url'
  );

  it('accepts a stable cursor for equivalent query values', () => {
    const query = { ...box, limit: 50 };
    const result = decodeSearchCursor(cursor, query);
    expect(result.date.toISOString()).toBe(date);
    expect(result.id.toHexString()).toBe(id);
  });

  it.each([
    { west: 22.81 },
    { minPrice: 0 },
    { minBedrooms: 1 },
    { minAreaM2: 50 },
    { maxPrice: 100 },
    { transactionType: 'sale' as const },
    { propertyType: 'house' as const }
  ])('rejects cursors reused with changed filters %j', (extra) => {
    expect(() => decodeSearchCursor(cursor, { ...box, ...extra })).toThrow(BadRequestException);
  });

  it.each([
    'invalid',
    '',
    'x'.repeat(257),
    Buffer.from(JSON.stringify(['invalid', id, searchFingerprint(box)])).toString('base64url')
  ])('rejects invalid cursor encodings', (value) => {
    expect(() => decodeSearchCursor(value, box)).toThrow(BadRequestException);
  });
});

describe('search resource budget', () => {
  it('hints the geographic index, sets a timeout and reports query timeout as unavailable', async () => {
    const aggregate = vi.fn(() => ({ toArray: () => Promise.reject({ code: 50 }) }));
    const orm = { em: { fork: () => ({ getCollection: () => ({ aggregate }) }) } };
    const service = new SearchService(orm as unknown as MikroORM, {} as Configuration);
    await expect(service.search(box)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(aggregate).toHaveBeenCalledWith(expect.any(Array), {
      hint: 'public_search_geo',
      maxTimeMS: 2000,
      allowDiskUse: false
    });
  });

  it('retains exact inclusive bounds and applies independent response caps', () => {
    const pipeline = buildSearchPipeline(box);
    expect(pipeline[0]).toMatchObject({
      $match: {
        publicLocation: { $geoWithin: { $centerSphere: expect.any(Array) } },
        'publicLocation.coordinates.0': { $gte: box.west, $lte: box.east },
        'publicLocation.coordinates.1': { $gte: box.south, $lte: box.north }
      }
    });
    expect(pipeline).toContainEqual({ $limit: 21 });
    expect(buildSearchPipeline(box, new Date(), 'markers')).toContainEqual({ $limit: 501 });
  });
});
