import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MongoDriver } from '@mikro-orm/mongodb';
import { Configuration } from '../configuration.js';
import { ormOptions } from './orm-options.js';
import { PropertySnapshots } from './snapshots.js';
import { OwnerWrites } from './owner-writes.js';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: MongoDriver,
      providers: [Configuration],
      inject: [Configuration],
      useFactory: (configuration: Configuration) => ({
        ...ormOptions(configuration.values.mongo.uri, configuration.values.mongo.dbName),
        registerRequestContext: true
      })
    })
  ],
  providers: [PropertySnapshots, OwnerWrites],
  exports: [PropertySnapshots, OwnerWrites]
})
export class DatabaseModule {}
