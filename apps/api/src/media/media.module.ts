import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module.js';
import { noStore } from '../auth/auth.http.js';
import { Configuration } from '../configuration.js';
import { DatabaseModule } from '../database/database.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { ImageProcessor } from './image-processor.js';
import { OwnerMediaController, PublicMediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { MediaWorker } from './media.worker.js';
import { MediaStorage } from './storage.js';

@Module({
  imports: [AuthModule, DatabaseModule, ListingsModule],
  controllers: [OwnerMediaController, PublicMediaController],
  providers: [Configuration, MediaService, MediaStorage, ImageProcessor, MediaWorker],
  exports: [MediaService, MediaStorage, ImageProcessor, MediaWorker]
})
export class MediaModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((_request: Request, response: Response, next: NextFunction) => {
        noStore(response);
        next();
      })
      .forRoutes(OwnerMediaController, PublicMediaController);
  }
}
