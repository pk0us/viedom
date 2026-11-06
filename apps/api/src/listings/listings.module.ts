import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AuthModule } from '../auth/auth.module.js';
import { noStore } from '../auth/auth.http.js';
import { DatabaseModule } from '../database/database.module.js';
import { Configuration } from '../configuration.js';
import { ListingsController, OwnerListingsController } from './listings.controller.js';
import { ListingMediaPolicy, ListingsPolicy } from './listings.policy.js';
import { ListingsService } from './listings.service.js';
import { ListingsPreviewService } from './listings-preview.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ListingsController, OwnerListingsController],
  providers: [
    Configuration,
    ListingsService,
    ListingsPreviewService,
    ListingsPolicy,
    ListingMediaPolicy
  ],
  exports: [ListingsPolicy, ListingMediaPolicy]
})
export class ListingsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((_request: Request, response: Response, next: NextFunction) => {
        noStore(response);
        next();
      })
      .forRoutes(ListingsController, OwnerListingsController);
  }
}
