import type { loadConfig } from '../../../../scripts/config.mjs';

type Config = ReturnType<typeof loadConfig>;

/** Check before opening a connection, even if a deployment was mislabelled development. */
export function localTarget(config: Config, test: boolean): { uri: string; dbName: string } {
  if (!['development', 'test'].includes(config.mode))
    throw new Error('Database tooling refuses production.');
  const uri = test ? config.mongo.testUri : config.mongo.uri;
  const dbName = test ? config.mongo.testDbName : config.mongo.dbName;
  const parsed = new URL(uri);
  if (
    parsed.protocol !== 'mongodb:' ||
    parsed.hostname !== '127.0.0.1' ||
    Number(parsed.port || 27017) !== config.ports.mongo ||
    !parsed.username ||
    !parsed.password ||
    parsed.pathname !== `/${dbName}` ||
    parsed.searchParams.get('authSource') !== dbName ||
    parsed.searchParams.get('replicaSet') !== 'rs0' ||
    parsed.searchParams.get('directConnection') !== 'true' ||
    !/(?:^|_)(?:local|dev|test)(?:_|$)/.test(dbName) ||
    /(?:^|_)(?:prod|production|staging)(?:_|$)/i.test(dbName) ||
    config.mongo.dbName === config.mongo.testDbName
  )
    throw new Error(
      'Database tooling requires a distinct authenticated loopback local/dev/test target.'
    );
  if (test && !/(?:^|_)test(?:_|$)/.test(dbName))
    throw new Error('Integration checks require a test-named database.');
  return { uri, dbName };
}
