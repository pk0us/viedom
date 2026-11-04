import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MongoDriver } from '@mikro-orm/mongodb';
import { Configuration } from '../configuration.js';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: MongoDriver,
      providers: [Configuration],
      inject: [Configuration],
      useFactory: (configuration: Configuration) => ({
        driver: MongoDriver,
        clientUrl: configuration.values.mongo.uri,
        dbName: configuration.values.mongo.dbName,
        entities: [],
        discovery: { warnWhenNoEntities: false },
        registerRequestContext: true,
        logger: () => undefined,
        // One host-run OLTP process; retain pool defaults until measured.
        // A 3s connection budget bounds readiness during local DB outages.
        driverOptions: { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 }
      })
    })
  ]
})
export class DatabaseModule {}
