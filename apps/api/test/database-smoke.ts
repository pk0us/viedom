import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from '../../../scripts/config.mjs';
import { initializeOrm, ormOptions } from '../src/database/orm-options.js';

const config = loadConfig();
if (config.mode === 'production') throw new Error('Database smoke refuses production.');
const options = {
  ...ormOptions(config.mongo.testUri, config.mongo.testDbName),
  entities: [],
  discovery: { warnWhenNoEntities: false },
  driverOptions: { serverSelectionTimeoutMS: 5000 }
};
const orm = await initializeOrm(options);
const connection = orm.em.getConnection();
const client = connection.getClient();
const db = connection.getDb();
const collection = db.collection<{ _id: string; marker: string }>('phase02_probe');
const id = process.env['SMOKE_PROBE_ID'] ?? randomUUID();
const mode = process.argv[2];
try {
  const hello = await db.command({ hello: 1 });
  assert.equal(hello['setName'], 'rs0');
  assert.equal(hello['isWritablePrimary'], true);
  if (mode === 'verify') {
    assert.equal((await collection.findOne({ _id: id }))?.marker, 'committed');
    await collection.deleteOne({ _id: id });
    console.log('PASS: transaction probe survived normal Compose down/up.');
  } else {
    if (!(await db.listCollections({ name: 'phase02_probe' }).hasNext()))
      await db.createCollection('phase02_probe');
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await collection.insertOne({ _id: id, marker: 'committed' }, { session });
      });
      assert.equal((await collection.findOne({ _id: id }))?.marker, 'committed');
      await assert.rejects(
        session.withTransaction(async () => {
          await collection.updateOne({ _id: id }, { $set: { marker: 'rolled-back' } }, { session });
          throw new Error('intentional rollback');
        }),
        /intentional rollback/
      );
      assert.equal((await collection.findOne({ _id: id }))?.marker, 'committed');
    } finally {
      await session.endSession();
    }
    await assert.rejects(
      client.db(config.mongo.dbName).collection('phase02_probe').findOne({}),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === 13
    );
    if (mode !== 'write') await collection.deleteOne({ _id: id });
    console.log(
      'PASS: authenticated host connection, transaction commit/rollback, test-user database isolation.'
    );
  }
} catch {
  console.error(
    'Database smoke failed. Check infrastructure readiness and credentials; details withheld.'
  );
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
