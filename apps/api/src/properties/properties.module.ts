import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AuthModule } from '../auth/auth.module.js';
import { noStore } from '../auth/auth.http.js';
import { DatabaseModule } from '../database/database.module.js';
import { PropertiesController } from './properties.controller.js';
import { PropertiesService } from './properties.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [PropertiesController],
  providers: [PropertiesService]
})
export class PropertiesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((_request: Request, response: Response, next: NextFunction) => {
        noStore(response);
        next();
      })
      .forRoutes(PropertiesController);
  }
}
