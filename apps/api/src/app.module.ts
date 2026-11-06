import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './auth/auth.module.js';
import { PropertiesModule } from './properties/properties.module.js';
import { ListingsModule } from './listings/listings.module.js';
import { MediaModule } from './media/media.module.js';
import { OpenApiController } from './openapi.js';

@Module({
  imports: [HealthModule, AuthModule, PropertiesModule, ListingsModule, MediaModule],
  controllers: [OpenApiController]
})
export class AppModule {}
