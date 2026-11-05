import { MongoDriver } from '@mikro-orm/mongodb';
import { entities } from './entities.js';
import { DomainSubscriber } from './domain-subscriber.js';

/** No automatic schema/index changes on application startup. */
export function ormOptions(clientUrl: string, dbName: string) {
  return {
    driver: MongoDriver,
    clientUrl,
    dbName,
    entities,
    subscribers: [new DomainSubscriber()],
    ensureIndexes: false,
    logger: () => undefined,
    // One host-run OLTP process; retain pool defaults until measured.
    driverOptions: { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 }
  };
}
