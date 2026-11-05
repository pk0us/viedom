import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MongoDriver } from '@mikro-orm/mongodb';
import { Configuration } from '../configuration.js';
import { ormOptions } from './orm-options.js';
import { PropertySnapshots } from './snapshots.js';

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
  providers: [PropertySnapshots],
  exports: [PropertySnapshots]
})
export class DatabaseModule {}
