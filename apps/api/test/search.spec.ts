import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { MikroORM, ObjectId } from '@mikro-orm/mongodb';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../scripts/config.mjs';
import { Configuration } from '../src/configuration.js';
import { ApiErrorFilter } from '../src/api-error.filter.js';
import { OpenApiController } from '../src/openapi.js';
import { localTarget } from '../src/database/local-target.js';
import { initializeOrm, ormOptions } from '../src/database/orm-options.js';
import { provision } from '../src/database/provision.js';
import { Listing, Property, User } from '../src/database/entities.js';
import { approximateLocation } from '../src/database/domain.js';
import { MediaAsset, MediaGallery } from '../src/media/media.entities.js';
import { SearchModule } from '../src/search/search.module.js';
import { buildSearchPipeline } from '../src/search/search.service.js';
import type { ListingSearchQueryDto } from '../src/search/search.dto.js';

const config = loadConfig();
const run = new ObjectId().toHexString();
const users: User[] = [];
const listingIds: ObjectId[] = [];
const propertyIds: ObjectId[] = [];
const assetIds: ObjectId[] = [];
const galleryIds: ObjectId[] = [];
let orm: MikroORM;
let app: INestApplication;
let base: string;
let owner: User;
const publishedAt = new Date('2026-01-01T00:00:00Z');

type Bounds = { west: number; south: number; east: number; north: number };
type Fixture = { listing: Listing; property: Property; asset: MediaAsset; gallery: MediaGallery };
type CardPage = { items: Array<{ id: string; [key: string]: unknown }>; nextCursor: string | null };
type MarkerPage = {
  items: Array<{ id: string; [key: string]: unknown }>;
  capped: boolean;
  limit: number;
};

function bounds(west: number): Bounds {
  return { west, south: 30, east: west + 0.1, north: 30.1 };
}

function query(box: Bounds, extra: Record<string, string | number> = {}) {
  return new URLSearchParams(
    Object.fromEntries(
      Object.entries({ ...box, ...extra }).map(([key, value]) => [key, String(value)])
    )
  ).toString();
}

function request(endpoint: 'search' | 'markers', value: string) {
  return fetch(`${base}/api/listings/${endpoint}?${value}`);
}

async function page(box: Bounds, extra: Record<string, string | number> = {}): Promise<CardPage> {
  const response = await request('search', query(box, extra));
  expect(response.status).toBe(200);
  return response.json();
}

async function markers(
  box: Bounds,
  extra: Record<string, string | number> = {}
): Promise<MarkerPage> {
  const response = await request('markers', query(box, extra));
  expect(response.status).toBe(200);
  return response.json();
}

async function account(extra: Partial<User> = {}) {
  const user = Object.assign(new User(), {
    email: `${run}.${users.length}@example.invalid`,
    firstName: 'Private synthetic first name',
    lastName: 'Private synthetic last name',
    passwordHash: 'PRIVATE SYNTHETIC PASSWORD HASH',
    phone: 'PRIVATE SYNTHETIC PHONE',
    emailVerifiedAt: new Date(),
    ...extra
  });
  users.push(user);
  await orm.em
    .getConnection()
    .getDb()
    .collection('users')
    .insertOne({ ...user });
  return user;
}

function fixture(box: Bounds, extra: Partial<Listing> = {}, publisher = owner): Fixture {
  const point = {
    type: 'Point' as const,
    coordinates: [(box.west + box.east) / 2, (box.south + box.north) / 2] as [number, number]
  };
  const property = Object.assign(new Property(), {
    ownerId: publisher._id,
    type: extra.propertyType ?? 'apartment',
    details: {
      areaM2: extra.areaM2 ?? 70,
      bedrooms: extra.bedrooms ?? 2,
      bathrooms: extra.bathrooms ?? 1,
      floor: 2,
      yearBuilt: null,
      amenities: []
    },
    address: {
      countryCode: 'GR',
      city: 'Synthetic city',
      neighborhood: 'Synthetic neighborhood',
      street: 'PRIVATE SYNTHETIC STREET'
    },
    privateLocation: extra.publicLocation ?? point,
    publicLocation: approximateLocation(extra.publicLocation ?? point),
    fixtureKey: run
  });
  const listing = Object.assign(new Listing(), {
    propertyId: property._id,
    publisherId: publisher._id,
    propertyVersion: property.version,
    propertyType: property.type,
    areaM2: property.details.areaM2,
    bedrooms: property.details.bedrooms,
    bathrooms: property.details.bathrooms,
    city: property.address.city,
    neighborhood: property.address.neighborhood,
    title: 'Synthetic public apartment',
    slug: 'synthetic-public-apartment',
    description: 'PRIVATE DESCRIPTION NOT PART OF A SEARCH CARD',
    priceMinor: 65_000,
    status: 'published',
    submittedVersion: 1,
    approvedVersion: 1,
    reviewedById: new ObjectId(),
    publishedAt,
    fixtureKey: run,
    ...extra,
    publicLocation: property.publicLocation
  });
  const asset = Object.assign(new MediaAsset(), {
    listingId: listing._id,
    ownerId: publisher._id,
    state: 'ready',
    originalKey: `private-search-original/${run}/${listing._id}`,
    contentType: 'image/jpeg',
    expectedBytes: 100,
    uploadExpiresAt: new Date(Date.now() + 60_000)
  });
  const large = `private-search-derivative/${run}/${asset._id}/large`;
  const thumbnail = `private-search-derivative/${run}/${asset._id}/thumbnail`;
  asset.processingKeys = [large, thumbnail];
  asset.variants = {
    large: { key: large, width: 800, height: 600, bytes: 100 },
    thumbnail: { key: thumbnail, width: 400, height: 300, bytes: 50 }
  };
  const gallery = Object.assign(new MediaGallery(), {
    listingId: listing._id,
    ownerId: publisher._id,
    mediaIds: [asset._id.toHexString()],
    coverMediaId: asset._id.toHexString()
  });
  listingIds.push(listing._id);
  propertyIds.push(property._id);
  assetIds.push(asset._id);
  galleryIds.push(gallery._id);
  return { listing, property, asset, gallery };
}

async function save(fixtures: Fixture[]) {
  if (!fixtures.length) return;
  const db = orm.em.getConnection().getDb();
  await db.collection('properties').insertMany(fixtures.map(({ property }) => ({ ...property })));
  await db.collection('listings').insertMany(fixtures.map(({ listing }) => ({ ...listing })));
  await db.collection('media_assets').insertMany(fixtures.map(({ asset }) => ({ ...asset })));
  await db
    .collection('media_galleries')
    .insertMany(fixtures.map(({ gallery }) => ({ ...gallery })));
}

beforeAll(async () => {
  const target = localTarget(config, true);
  orm = await initializeOrm(ormOptions(target.uri, target.dbName));
  await provision(orm);
  const testing = await Test.createTestingModule({
    imports: [SearchModule],
    controllers: [OpenApiController]
  })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .overrideProvider(CoreMikroORM)
    .useValue(orm)
    .overrideProvider(Configuration)
    .useValue({ values: config })
    .compile();
  app = testing.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );
  app.useGlobalFilters(new ApiErrorFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  owner = await account();
});

afterAll(async () => {
  if (orm) {
    const db = orm.em.getConnection().getDb();
    for (const [name, ids] of [
      ['media_assets', assetIds],
      ['media_galleries', galleryIds],
      ['listings', listingIds],
      ['properties', propertyIds],
      ['users', users.map((user) => user._id)]
    ] as const)
      await db.collection(name).deleteMany({ _id: { $in: ids } });
  }
  await app?.close();
  await orm?.close(true);
});

it('validates strict bounded shared filters and rejects repeated, unknown and abusive input', async () => {
  const box = bounds(10);
  const invalid = [
    '',
    'west=10&south=30&east=10.1',
    query(box, { west: 'NaN' }),
    query(box, { north: 'Infinity' }),
    query(box, { west: -181 }),
    query(box, { north: 91 }),
    query(box, { east: 10 }),
    query(box, { north: 30 }),
    query(box, { west: 11 }),
    query(box, { south: 31 }),
    query(box, { east: 11.0001 }),
    query(box, { north: 31.0001 }),
    query(box, { west: 179.9, east: -179.9 }),
    query(box, { west: -180, east: 180 }),
    query(box, { transactionType: 'lease' }),
    query(box, { propertyType: 'castle' }),
    query(box, { minPrice: -1 }),
    query(box, { maxPrice: '1.5' }),
    query(box, { minPrice: 100_000_000_001 }),
    query(box, { minPrice: 100, maxPrice: 99 }),
    query(box, { minBedrooms: '1.5' }),
    query(box, { minBedrooms: 101 }),
    query(box, { minAreaM2: -1 }),
    query(box, { minAreaM2: 100_001 }),
    query(box, { west: '' }),
    query(box, { minPrice: '' }),
    query(box, { propertyType: '$ne' }),
    `${query(box)}&west=10`,
    `${query(box)}&transactionType=rent&transactionType=sale`,
    `${query(box)}&minPrice[$gt]=1`,
    `${query(box)}&privateLocation=1`,
    `${query(box)}&unknown=${'x'.repeat(5000)}`
  ];
  for (const endpoint of ['search', 'markers'] as const)
    for (const input of invalid) {
      const response = await request(endpoint, input);
      expect(response.status, `${endpoint}: ${input.slice(0, 200)}`).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
  for (const input of [
    query(box, { limit: 0 }),
    query(box, { limit: 51 }),
    query(box, { limit: '1.5' }),
    query(box, { cursor: 'invalid' }),
    query(box, { cursor: 'x'.repeat(2049) }),
    `${query(box)}&limit=2&limit=3`
  ])
    expect((await request('search', input)).status).toBe(400);
  for (const extra of [{ limit: 1 }, { cursor: 'anything' }])
    expect((await request('markers', query(box, extra))).status).toBe(400);
});

it('includes every geographic edge and corner while excluding immediately outside points', async () => {
  const lower = approximateLocation({ type: 'Point', coordinates: [11, 30] }).coordinates;
  const upper = approximateLocation({ type: 'Point', coordinates: [11.1, 30.1] }).coordinates;
  const box = { west: lower[0], south: lower[1], east: upper[0], north: upper[1] };
  const { west, south, east, north } = box;
  const middle = approximateLocation({ type: 'Point', coordinates: [11.05, 30.05] }).coordinates;
  const middleX = middle[0];
  const middleY = middle[1];
  const inside = [
    [west, south],
    [west, north],
    [east, south],
    [east, north],
    [west, middleY],
    [east, middleY],
    [middleX, south],
    [middleX, north],
    [middleX, middleY]
  ];
  const outside = [
    [west - 0.004, middleY],
    [east + 0.004, middleY],
    [middleX, south - 0.003],
    [middleX, north + 0.003]
  ];
  const create = (coordinates: number[]) =>
    fixture(box, {
      publicLocation: { type: 'Point', coordinates: coordinates as [number, number] }
    });
  const expected = inside.map(create);
  await save([...expected, ...outside.map(create)]);
  const ids = expected.map(({ listing }) => listing._id.toHexString()).sort();
  expect((await page(box)).items.map((row) => row.id).sort()).toEqual(ids);
  expect((await markers(box)).items.map((row) => row.id).sort()).toEqual(ids);
});

it('combines rent/sale, cents, property type, bedrooms and area identically for cards and markers', async () => {
  const box = bounds(12);
  const matching = fixture(box, { priceMinor: 80_000, areaM2: 85, bedrooms: 3 });
  const fixtures = [
    matching,
    fixture(box, { transactionType: 'sale' }),
    fixture(box, { priceMinor: 79_999 }),
    fixture(box, { priceMinor: 90_001 }),
    fixture(box, { propertyType: 'studio' }),
    fixture(box, { bedrooms: 2 }),
    fixture(box, { areaM2: 84.9 })
  ];
  await save(fixtures);
  const filters = {
    transactionType: 'rent',
    minPrice: 80_000,
    maxPrice: 90_000,
    propertyType: 'apartment',
    minBedrooms: 3,
    minAreaM2: 85
  };
  const expected = [matching.listing._id.toHexString()];
  expect((await page(box, filters)).items.map((row) => row.id)).toEqual(expected);
  expect((await markers(box, filters)).items.map((row) => row.id)).toEqual(expected);
  expect((await page(box, { transactionType: 'sale' })).items.map((row) => row.id)).toEqual([
    fixtures[1]!.listing._id.toHexString()
  ]);
});

it('handles legal polar and dateline-adjacent city-sized bounds', async () => {
  for (const [box, coordinates] of [
    [{ west: 179.9, south: 0, east: 180, north: 0.1 }, [180, 0.05]],
    [{ west: -180, south: 0, east: -179.9, north: 0.1 }, [-180, 0.05]],
    [{ west: 170, south: 89.9, east: 170.1, north: 90 }, [170.05, 90]]
  ] as const) {
    const row = fixture(box, {
      publicLocation: { type: 'Point', coordinates: [...coordinates] }
    });
    await save([row]);
    const expected = [row.listing._id.toHexString()];
    expect((await page(box)).items.map((item) => item.id)).toEqual(expected);
    expect((await markers(box)).items.map((item) => item.id)).toEqual(expected);
  }
});

it('keeps deterministic timestamp-tied pagination, default/max limits and query-bound cursors', async () => {
  const box = bounds(13);
  const fixtures = Array.from({ length: 55 }, () => fixture(box));
  await save(fixtures);
  expect((await page(box)).items).toHaveLength(20);
  expect((await page(box, { limit: 50 })).items).toHaveLength(50);
  const first = await page(box, { limit: 7 });
  expect(first.nextCursor).toBeTypeOf('string');
  const found = first.items.map((row) => row.id);
  let cursor = first.nextCursor;
  for (let iteration = 0; cursor && iteration < 20; iteration++) {
    const result = await page(box, { limit: 7, cursor });
    found.push(...result.items.map((row) => row.id));
    cursor = result.nextCursor;
  }
  expect(cursor).toBeNull();
  expect(found).toEqual(
    fixtures
      .map(({ listing }) => listing._id.toHexString())
      .sort()
      .reverse()
  );
  for (const extra of [
    { transactionType: 'sale' },
    { minPrice: 1 },
    { propertyType: 'house' },
    { west: box.west + 0.01 }
  ])
    expect(
      (await request('search', query(box, { limit: 7, cursor: first.nextCursor!, ...extra })))
        .status
    ).toBe(400);
  expect(
    (await request('search', query(box, { cursor: `${first.nextCursor!.slice(0, -2)}xx` }))).status
  ).toBe(400);
});

it('reports a 500-marker cap while preserving independently paginated dense cards', async () => {
  const box = bounds(14);
  const fixtures = Array.from({ length: 503 }, () => fixture(box));
  await save(fixtures);
  const result = await markers(box);
  expect(result.items).toHaveLength(500);
  expect(result.capped).toBe(true);
  expect(result.limit).toBe(500);
  expect(Object.keys(result).sort()).toEqual(['capped', 'items', 'limit']);
  const found: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await page(box, { limit: 50, ...(cursor ? { cursor } : {}) });
    found.push(...response.items.map((row) => row.id));
    cursor = response.nextCursor;
  } while (cursor && found.length <= 550);
  expect(new Set(found).size).toBe(503);
  expect(found).toHaveLength(503);
  await orm.em
    .getConnection()
    .getDb()
    .collection('listings')
    .updateMany(
      { _id: { $in: fixtures.slice(0, 3).map(({ listing }) => listing._id) } },
      { $set: { status: 'paused' } }
    );
  const exactLimit = await markers(box);
  expect(exactLimit.items).toHaveLength(500);
  expect(exactLimit.capped).toBe(false);
  expect(await markers(box, { transactionType: 'sale' })).toEqual({
    items: [],
    capped: false,
    limit: 500
  });
});

it('excludes every non-public listing, account and incomplete or foreign media state', async () => {
  const box = bounds(15);
  const valid = fixture(box);
  const invalid: Fixture[] = [];
  for (const status of ['draft', 'pending_review', 'rejected', 'paused', 'archived'] as const)
    invalid.push(fixture(box, { status }));
  for (const extra of [
    { approvedVersion: null },
    { version: 2 },
    { submittedVersion: null },
    { submittedVersion: 2 },
    { publishedAt: null },
    { publishedAt: new Date(Date.now() + 60_000) },
    { expiresAt: new Date(0) },
    { expiresAt: new Date() },
    { moderationHold: true },
    { deletedAt: new Date() },
    { reviewedById: null },
    { reviewedById: owner._id }
  ])
    invalid.push(fixture(box, extra));
  for (const extra of [
    { status: 'suspended' as const },
    { status: 'deleted' as const },
    { deletedAt: new Date() },
    { emailVerifiedAt: null }
  ])
    invalid.push(fixture(box, {}, await account(extra)));
  const missingOwner = fixture(box);
  missingOwner.listing.publisherId = new ObjectId();
  invalid.push(missingOwner);
  for (const state of ['awaiting_upload', 'queued', 'processing', 'failed', 'deleted'] as const) {
    const row = fixture(box);
    row.asset.state = state;
    invalid.push(row);
  }
  for (const mutate of [
    (row: Fixture) => {
      row.gallery.mediaIds = [];
      row.gallery.coverMediaId = null;
    },
    (row: Fixture) => {
      row.gallery.coverMediaId = null;
    },
    (row: Fixture) => {
      row.gallery.coverMediaId = new ObjectId().toHexString();
    },
    (row: Fixture) => {
      row.gallery.ownerId = new ObjectId();
    },
    (row: Fixture) => {
      row.gallery.listingId = new ObjectId();
    },
    (row: Fixture) => {
      row.asset.ownerId = new ObjectId();
    },
    (row: Fixture) => {
      row.asset.listingId = new ObjectId();
    },
    (row: Fixture) => {
      row.gallery.mediaIds.push(new ObjectId().toHexString());
    },
    (row: Fixture) => {
      row.asset.variants = null;
    },
    (row: Fixture) => {
      row.asset.processingKeys = [];
    },
    (row: Fixture) => {
      row.asset.processingKeys = [row.asset.variants!.large.key];
    },
    (row: Fixture) => {
      row.property.ownerId = new ObjectId();
    },
    (row: Fixture) => {
      row.listing.propertyId = new ObjectId();
    },
    (row: Fixture) => {
      row.listing.propertyVersion = 2;
    }
  ]) {
    const row = fixture(box);
    mutate(row);
    invalid.push(row);
  }
  await save([valid, ...invalid]);
  const expected = [valid.listing._id.toHexString()];
  expect((await page(box)).items.map((row) => row.id)).toEqual(expected);
  expect((await markers(box)).items.map((row) => row.id)).toEqual(expected);
  expect((await fetch(`${base}/api/listings/${valid.listing._id}`)).status).toBe(200);
  const unavailable = new Set(invalid.map(({ listing }) => listing._id.toHexString()));
  for (const id of unavailable) {
    const response = await fetch(`${base}/api/listings/${id}`);
    expect(response.status, id).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  const sitemap = await (await fetch(`${base}/api/listings/sitemap`)).json();
  expect(sitemap.items.some((item: { id: string }) => unavailable.has(item.id))).toBe(false);
});

it('returns explicit public projections without private addresses, locations, ownership, storage or account secrets', async () => {
  const box = bounds(16);
  const row = fixture(box);
  await save([row]);
  const cards = await page(box);
  const pins = await markers(box);
  expect(Object.keys(cards.items[0]!).sort()).toEqual(
    [
      'id',
      'title',
      'slug',
      'transactionType',
      'priceMinor',
      'currency',
      'propertyType',
      'areaM2',
      'bedrooms',
      'bathrooms',
      'city',
      'neighborhood',
      'publicLocation',
      'locationPrecision',
      'publishedAt',
      'coverImage'
    ].sort()
  );
  expect(Object.keys(pins.items[0]!).sort()).toEqual(
    [
      'id',
      'priceMinor',
      'currency',
      'transactionType',
      'publicLocation',
      'locationPrecision'
    ].sort()
  );
  expect(cards.items[0]).toMatchObject({
    publicLocation: row.listing.publicLocation,
    locationPrecision: 'approximate',
    publishedAt: publishedAt.toISOString(),
    coverImage: { width: 400, height: 300 }
  });
  const payload = JSON.stringify({ cards, pins });
  for (const forbidden of [
    'privateLocation',
    'street',
    'passwordHash',
    'fixtureKey',
    'ownerId',
    'publisherId',
    'reviewedById',
    'propertyVersion',
    'submittedVersion',
    'approvedVersion',
    'moderationHold',
    'processingKeys',
    'originalKey',
    'leaseToken',
    'accessToken',
    'refreshToken',
    'private-search-original',
    'private-search-derivative',
    'PRIVATE',
    owner.email,
    owner.passwordHash!,
    owner.phone!
  ])
    expect(payload).not.toContain(forbidden);
});

it('documents public security, shared filters and bounded search responses', async () => {
  const response = await fetch(`${base}/api/openapi.json`);
  expect(response.status).toBe(200);
  const document = await response.json();
  for (const path of ['/listings/search', '/listings/markers']) {
    const operation = document.paths[path].get;
    expect(operation.security).toEqual([]);
    expect(operation.responses['200']).toBeDefined();
    expect(operation.responses['400']).toBeDefined();
    for (const name of [
      'west',
      'south',
      'east',
      'north',
      'transactionType',
      'minPrice',
      'maxPrice',
      'propertyType',
      'minBedrooms',
      'minAreaM2'
    ])
      expect(
        operation.parameters.some((parameter: { name: string }) => parameter.name === name)
      ).toBe(true);
  }
  const cardLimit = document.paths['/listings/search'].get.parameters.find(
    (parameter: { name: string }) => parameter.name === 'limit'
  );
  expect(cardLimit.schema).toMatchObject({ default: 20, maximum: 50 });
  expect(
    document.paths['/listings/markers'].get.parameters.some((parameter: { name: string }) =>
      ['cursor', 'limit'].includes(parameter.name)
    )
  ).toBe(false);
});

it.runIf(process.env['VIEDOM_SEARCH_BENCHMARK'] === '1')(
  'records real MongoDB indexed plans and the 10000-listing 25-client synthetic benchmark',
  async () => {
    const box = { west: 20, south: 40, east: 21, north: 41 };
    for (let batch = 0; batch < 10; batch++) {
      const fixtures = Array.from({ length: 1000 }, (_, offset) => {
        const index = batch * 1000 + offset;
        return fixture(box, {
          publicLocation: {
            type: 'Point',
            coordinates: [
              20.005 + (index % 100) * 0.0099,
              40.005 + Math.floor(index / 100) * 0.0099
            ]
          },
          transactionType: index % 3 === 0 ? 'sale' : 'rent',
          priceMinor: 50_000 + (index % 100) * 1000
        });
      });
      await save(fixtures);
    }
    const workload = {
      ...box,
      transactionType: 'rent',
      minPrice: 60_000,
      maxPrice: 120_000,
      limit: 20
    };
    const db = orm.em.getConnection().getDb();
    const explains: Record<string, unknown> = {};
    const executionPlans: Record<string, unknown> = {};
    function inspect(
      value: unknown,
      plans: Array<Record<string, unknown>>,
      lookups: Array<Record<string, unknown>>
    ) {
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (record.executionStats && typeof record.executionStats === 'object')
        plans.push(record.executionStats as Record<string, unknown>);
      if (record['$lookup']) {
        const lookup = record['$lookup'] as Record<string, unknown>;
        lookups.push({
          from: lookup.from,
          totalDocsExamined: record.totalDocsExamined,
          totalKeysExamined: record.totalKeysExamined,
          collectionScans: record.collectionScans,
          indexesUsed: record.indexesUsed,
          nReturned: record.nReturned,
          executionTimeMillisEstimate: record.executionTimeMillisEstimate
        });
      }
      for (const nested of Object.values(record)) {
        if (Array.isArray(nested)) nested.forEach((item) => inspect(item, plans, lookups));
        else if (nested && typeof nested === 'object') inspect(nested, plans, lookups);
      }
    }
    for (const mode of ['cards', 'markers'] as const) {
      const pipeline = buildSearchPipeline(workload as ListingSearchQueryDto, new Date(), mode);
      const explain = await db
        .collection('listings')
        .aggregate(pipeline, {
          hint: 'public_search_geo',
          allowDiskUse: false
        })
        .explain('executionStats');
      expect(JSON.stringify(explain)).toContain('public_search_geo');
      const plans: Array<Record<string, unknown>> = [];
      const lookups: Array<Record<string, unknown>> = [];
      inspect(explain, plans, lookups);
      explains[mode] = explain;
      executionPlans[mode] = {
        cursor: plans.map(
          ({ nReturned, executionTimeMillis, totalKeysExamined, totalDocsExamined }) => ({
            nReturned,
            executionTimeMillis,
            totalKeysExamined,
            totalDocsExamined
          })
        ),
        lookups
      };
    }
    const input = query(box, { transactionType: 'rent', minPrice: 60_000, maxPrice: 120_000 });
    for (let warmup = 0; warmup < 3; warmup++) {
      for (const endpoint of ['search', 'markers'] as const) {
        const response = await request(endpoint, input);
        expect(response.status).toBe(200);
        await response.json();
      }
    }
    const latencies: Record<'search' | 'markers', number[]> = { search: [], markers: [] };
    const payloadBytes: Record<'search' | 'markers', number[]> = { search: [], markers: [] };
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 25 }, async () => {
        for (let iteration = 0; iteration < 6; iteration++) {
          const endpoint = iteration % 2 === 0 ? 'search' : 'markers';
          const begin = performance.now();
          const response = await request(endpoint, input);
          expect(response.status).toBe(200);
          const body = await response.text();
          JSON.parse(body);
          latencies[endpoint].push(performance.now() - begin);
          payloadBytes[endpoint].push(Buffer.byteLength(body));
        }
      })
    );
    const elapsedMs = performance.now() - started;
    const summary = Object.fromEntries(
      Object.entries(latencies).map(([endpoint, values]) => {
        const ordered = [...values].sort((a, b) => a - b);
        return [
          endpoint,
          {
            samples: values.length,
            p50Ms: Number(ordered[Math.ceil(ordered.length * 0.5) - 1]!.toFixed(2)),
            p95Ms: Number(ordered[Math.ceil(ordered.length * 0.95) - 1]!.toFixed(2)),
            maxMs: Number(ordered.at(-1)!.toFixed(2)),
            proposedP95BudgetMs: 500,
            meetsProposedBudget: ordered[Math.ceil(ordered.length * 0.95) - 1]! < 500,
            payloadBytes: {
              min: Math.min(...payloadBytes[endpoint as 'search' | 'markers']),
              max: Math.max(...payloadBytes[endpoint as 'search' | 'markers'])
            }
          }
        ];
      })
    );
    const evidence = {
      recordedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: availableParallelism(),
        memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
        mongodb:
          'Existing authenticated loopback Docker replica set, separate guarded test database',
        transport:
          'Nest HTTP on loopback, JSON body consumed; includes local HTTP/serialization overhead'
      },
      syntheticListings: 10_000,
      clients: 25,
      requests: 150,
      warmupsPerEndpoint: 3,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      workload,
      payloadLimits: { cards: 20, markers: 500 },
      summary,
      executionPlans
    };
    const output = new URL('../../../test-results/search/', import.meta.url);
    await mkdir(output, { recursive: true });
    await writeFile(new URL('benchmark.json', output), `${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(new URL('explain.json', output), `${JSON.stringify(explains, null, 2)}\n`);
    console.info('SEARCH_BENCHMARK', JSON.stringify(evidence));
    console.info('SEARCH_BENCHMARK_OUTPUT', fileURLToPath(output));
  }
);

it('projects public detail with ordered processed photos and no private location or publisher data', async () => {
  const row = fixture(bounds(17));
  row.listing.description = 'Synthetic public description for the detail page.';
  const second = fixture(bounds(17));
  second.asset.listingId = row.listing._id;
  row.gallery.mediaIds = [second.asset._id.toHexString(), row.asset._id.toHexString()];
  row.gallery.coverMediaId = second.asset._id.toHexString();
  await save([row]);
  await orm.em
    .getConnection()
    .getDb()
    .collection('media_assets')
    .insertOne({ ...second.asset });
  const response = await fetch(`${base}/api/listings/${row.listing._id}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const detail = await response.json();
  expect(Object.keys(detail).sort()).toEqual([
    'content',
    'id',
    'locationPrecision',
    'publishedAt',
    'slug'
  ]);
  expect(detail).toMatchObject({
    id: row.listing._id.toHexString(),
    locationPrecision: 'approximate',
    content: {
      description: row.listing.description,
      property: { publicLocation: row.listing.publicLocation }
    }
  });
  expect(detail.content.media.items.map((item: { id: string }) => item.id)).toEqual(
    row.gallery.mediaIds
  );
  expect(detail.content.media.coverMediaId).toBe(row.gallery.coverMediaId);
  for (const item of detail.content.media.items) {
    for (const name of ['large', 'thumbnail']) {
      expect(item.variants[name].url).toBe(
        `${config.storage.deliveryBaseUrl}/${row.listing._id}/${item.id}/${name}`
      );
      expect(Object.keys(item.variants[name]).sort()).toEqual([
        'bytes',
        'contentType',
        'height',
        'url',
        'width'
      ]);
    }
  }
  const payload = JSON.stringify(detail);
  for (const value of [
    'privateLocation',
    'street',
    'ownerId',
    'publisherId',
    'reviewedById',
    'originalKey',
    'processingKeys',
    'private-search-',
    'PRIVATE',
    owner.email,
    owner.phone!
  ])
    expect(payload).not.toContain(value);
  for (const id of ['not-an-id', new ObjectId().toHexString()]) {
    const unavailable = await fetch(`${base}/api/listings/${id}`);
    expect(unavailable.status).toBe(404);
    expect((await unavailable.json()).error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Resource not found.'
    });
  }
  await orm.em
    .getConnection()
    .getDb()
    .collection('listings')
    .updateOne({ _id: row.listing._id }, { $set: { status: 'paused' } });
  expect((await fetch(`${base}/api/listings/${row.listing._id}`)).status).toBe(404);
});

it('returns six newest approved launch-city cards and removes withdrawn and suspended publications', async () => {
  const fixtures = Array.from({ length: 8 }, (_, index) =>
    fixture(bounds(18), { publishedAt: new Date(Date.now() - 1000 - index * 1000) })
  );
  for (const row of fixtures) {
    row.property.address.city = config.public.city;
    row.listing.city = config.public.city;
  }
  const foreign = fixture(bounds(18), { publishedAt: new Date(Date.now() - 500) });
  await save([...fixtures, foreign]);
  const response = await fetch(`${base}/api/listings/recent`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const recent = await response.json();
  expect(recent.items.map((item: { id: string }) => item.id)).toEqual(
    fixtures.slice(0, 6).map(({ listing }) => listing._id.toHexString())
  );
  await orm.em
    .getConnection()
    .getDb()
    .collection('listings')
    .updateOne({ _id: fixtures[0]!.listing._id }, { $set: { status: 'paused' } });
  const remaining = await (await fetch(`${base}/api/listings/recent`)).json();
  expect(remaining.items.map((item: { id: string }) => item.id)).toEqual(
    fixtures.slice(1, 7).map(({ listing }) => listing._id.toHexString())
  );
  await orm.em
    .getConnection()
    .getDb()
    .collection('users')
    .updateOne({ _id: owner._id }, { $set: { status: 'suspended' } });
  try {
    expect((await (await fetch(`${base}/api/listings/recent`)).json()).items).toEqual([]);
    expect((await fetch(`${base}/api/listings/${fixtures[1]!.listing._id}`)).status).toBe(404);
    const sitemap = await (await fetch(`${base}/api/listings/sitemap`)).json();
    const ids = new Set(fixtures.map(({ listing }) => listing._id.toHexString()));
    expect(sitemap.items.some((item: { id: string }) => ids.has(item.id))).toBe(false);
  } finally {
    await orm.em
      .getConnection()
      .getDb()
      .collection('users')
      .updateOne({ _id: owner._id }, { $set: { status: 'active' } });
  }
});

it('streams publication-aware sitemap pages with stable tied timestamps and rejects malformed continuation', async () => {
  const fixtures = Array.from({ length: 1002 }, () => fixture(bounds(19)));
  await save(fixtures);
  const expected = new Set(fixtures.map(({ listing }) => listing._id.toHexString()));
  const found: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const response: Response = await fetch(
      `${base}/api/listings/sitemap${cursor ? `?cursor=${cursor}` : ''}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result: {
      items: { id: string; slug: string; publishedAt: string }[];
      nextCursor: string | null;
    } = await response.json();
    expect(result.items.length).toBeLessThanOrEqual(1000);
    for (const item of result.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'publishedAt', 'slug']);
      if (expected.has(item.id)) found.push(item.id);
    }
    cursor = result.nextCursor;
    pages++;
  } while (cursor && pages < 5);
  expect(cursor).toBeNull();
  expect(pages).toBeGreaterThan(1);
  expect(found).toEqual([...expected].sort().reverse());
  expect(new Set(found).size).toBe(1002);
  for (const value of [
    'cursor=invalid',
    'cursor=one&cursor=two',
    'limit=1',
    'cursor[$ne]=1',
    `cursor=${'x'.repeat(257)}`
  ])
    expect((await fetch(`${base}/api/listings/sitemap?${value}`)).status).toBe(400);
});
