import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module.js';
import { noStore } from '../auth/auth.http.js';
import { Configuration } from '../configuration.js';
import { DatabaseModule } from '../database/database.module.js';
import {
  InquiriesController,
  InquiryOriginGuard,
  OptionalInquiryAuthGuard,
  OwnerInquiriesController
} from './inquiries.controller.js';
import { InquiriesService } from './inquiries.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [InquiriesController, OwnerInquiriesController],
  providers: [Configuration, InquiriesService, InquiryOriginGuard, OptionalInquiryAuthGuard]
})
export class InquiriesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((_request: Request, response: Response, next: NextFunction) => {
        noStore(response);
        next();
      })
      .forRoutes(InquiriesController, OwnerInquiriesController);
  }
}
