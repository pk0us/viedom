import { approximateLocation, normalizeEmail, validatePoint, validateProperty } from './domain.js';
import { fixtures } from './fixtures.js';
import { publicListingSummary } from './public-projection.js';
import { localTarget } from './local-target.js';
import { loadConfig } from '../../../../scripts/config.mjs';

it('normalizes email without changing provider-specific mailbox semantics', () => {
  expect(normalizeEmail('  Owner+home@Example.COM ')).toBe('owner+home@example.com');
  for (const invalid of ['broken', 'a b@example.com', 'a@localhost', 'a@example.com\nextra']) {
    expect(() => normalizeEmail(invalid)).toThrow('email');
  }
});

it('validates finite longitude/latitude in that order and keeps approximate pins stable', () => {
  const point = { type: 'Point' as const, coordinates: [22.9444, 40.6401] as [number, number] };
  expect(() => validatePoint({ type: 'Point', coordinates: [150, 45] })).not.toThrow();
  for (const coordinates of [[45, 150], [181, 40], [22, -91], [NaN, 40], [22, Infinity], [22]]) {
    expect(() => validatePoint({ type: 'Point', coordinates } as typeof point)).toThrow();
  }
  const approximate = approximateLocation(point);
  expect(approximateLocation(point)).toEqual(approximate);
  expect(approximate.coordinates).not.toEqual(point.coordinates);
  expect(Math.abs(approximate.coordinates[0] - point.coordinates[0])).toBeLessThan(0.0018);
  expect(Math.abs(approximate.coordinates[1] - point.coordinates[1])).toBeLessThan(0.0014);
});

it('accepts studio/ground-floor bounds and rejects non-finite, fractional and oversized content', () => {
  const p = fixtures().properties[0]!;
  expect(() => validateProperty(p)).not.toThrow();
  for (const [field, value] of [
    ['areaM2', 0],
    ['areaM2', Infinity],
    ['bedrooms', -1],
    ['bedrooms', 1.5],
    ['floor', -11],
    ['yearBuilt', 2101]
  ] as const) {
    expect(() => validateProperty({ ...p, details: { ...p.details, [field]: value } })).toThrow();
  }
  expect(() =>
    validateProperty({ ...p, details: { ...p.details, amenities: Array(31).fill('lift') } })
  ).toThrow();
});

it('projects an exact public allowlist and blocks accidental entity JSON serialization', () => {
  const { users, properties, listings } = fixtures();
  const listing = listings[3]!;
  const result = publicListingSummary(listing);
  expect(Object.keys(result).sort()).toEqual(
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
      'city',
      'neighborhood',
      'publicLocation',
      'locationPrecision'
    ].sort()
  );
  const json = JSON.stringify(result);
  for (const secret of [
    'privateLocation',
    'street',
    'publisherId',
    'propertyId',
    'passwordHash',
    'email',
    'reviewedById',
    'fixtureKey',
    'approvedVersion',
    'moderationHold'
  ]) {
    expect(json).not.toContain(secret);
  }
  expect(json).not.toContain(JSON.stringify(properties[3]!.privateLocation.coordinates));
  result.publicLocation.coordinates[0] = 0;
  expect(listing.publicLocation.coordinates[0]).not.toBe(0);
  for (const entity of [users[0], properties[0], listing])
    expect(() => JSON.stringify(entity)).toThrow('explicit response mapper');
});

it('rejects production, remote, production-named, mismatched and shared database targets before connection', () => {
  const config = loadConfig();
  expect(localTarget(config, true).dbName).toBe(config.mongo.testDbName);
  expect(() => localTarget({ ...config, mode: 'production' }, false)).toThrow('production');
  for (const uri of [
    config.mongo.uri.replace('127.0.0.1', 'remote.example.com'),
    config.mongo.uri.replace('rs0', 'rs1')
  ]) {
    expect(() => localTarget({ ...config, mongo: { ...config.mongo, uri } }, false)).toThrow(
      'loopback'
    );
  }
  expect(() =>
    localTarget({ ...config, mongo: { ...config.mongo, dbName: 'viedom_prod_local' } }, false)
  ).toThrow();
  expect(() =>
    localTarget({ ...config, mongo: { ...config.mongo, testDbName: config.mongo.dbName } }, true)
  ).toThrow();
});
