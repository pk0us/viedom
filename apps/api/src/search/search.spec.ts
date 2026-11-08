import { BadRequestException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mongodb';
import type { ListingSearchQuery } from '@viedom/contracts';
import { Configuration } from '../configuration.js';
import { ListingMarkersQueryDto, ListingSearchQueryDto } from './search.dto.js';
import {
  buildSearchPipeline,
  decodeSearchCursor,
  decodeSitemapCursor,
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

describe('public listing discovery', () => {
  const configuration = {
    values: {
      public: { city: 'Thessaloniki' },
      storage: { deliveryBaseUrl: 'https://viedom.example/api/media' }
    }
  } as Configuration;
  const create = (rows: object[] = []) => {
    const aggregate = vi.fn<
      (pipeline: Record<string, unknown>[], options: object) => { toArray: () => Promise<object[]> }
    >(() => ({ toArray: () => Promise.resolve(rows) }));
    const orm = { em: { fork: () => ({ getCollection: () => ({ aggregate }) }) } };
    return { aggregate, service: new SearchService(orm as unknown as MikroORM, configuration) };
  };

  it('rejects invalid and unavailable detail IDs identically without a private lookup', async () => {
    const { service, aggregate } = create();
    await expect(service.detail('not-an-id')).rejects.toMatchObject({ status: 404 });
    expect(aggregate).not.toHaveBeenCalled();
    await expect(service.detail('a'.repeat(24))).rejects.toMatchObject({ status: 404 });
    expect(aggregate).toHaveBeenCalledWith(expect.any(Array), {
      hint: '_id_',
      maxTimeMS: 2000,
      allowDiskUse: false
    });
  });

  it('bounds recent launch-city and sitemap reads using the publication index', async () => {
    const { service, aggregate } = create();
    await expect(service.recent()).resolves.toEqual({ items: [] });
    expect(aggregate.mock.calls[0]![0]).toContainEqual({ $limit: 6 });
    expect(aggregate.mock.calls[0]![0][0]).toMatchObject({
      $match: { city: 'Thessaloniki', status: 'published' }
    });
    await expect(service.sitemap()).resolves.toEqual({ items: [], nextCursor: null });
    expect(aggregate.mock.calls[1]![0]).toContainEqual({ $limit: 1001 });
    expect(aggregate).toHaveBeenLastCalledWith(expect.any(Array), {
      hint: 'status_published',
      maxTimeMS: 2000,
      allowDiskUse: false
    });
  });

  it('keeps timestamp-tied sitemap continuation bounded and distinct from search cursors', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      id: i.toString(16).padStart(24, '0'),
      slug: 'synthetic',
      publishedAt: new Date('2026-01-01T00:00:00Z')
    }));
    const { service } = create(rows);
    const result = await service.sitemap();
    expect(result.items).toHaveLength(1000);
    expect(decodeSitemapCursor(result.nextCursor!)).toMatchObject({ date: rows[999]!.publishedAt });
    expect(decodeSitemapCursor(result.nextCursor!).id.toHexString()).toBe(rows[999]!.id);
    expect(() => decodeSearchCursor(result.nextCursor!, box)).toThrow(BadRequestException);
    const searchCursor = Buffer.from(
      JSON.stringify(['2026-01-01T00:00:00.000Z', rows[0]!.id, searchFingerprint(box)])
    ).toString('base64url');
    await expect(service.sitemap(searchCursor)).rejects.toBeInstanceOf(BadRequestException);
    for (const invalid of ['', 'invalid', 'x'.repeat(257)])
      expect(() => decodeSitemapCursor(invalid)).toThrow(BadRequestException);
  });
});
