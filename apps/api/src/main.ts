import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadConfig } from '../../../scripts/config.mjs';
import { ApiErrorFilter } from './api-error.filter.js';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();
  await app.listen(config.ports.api, config.mode === 'production' ? '0.0.0.0' : '127.0.0.1');
}
bootstrap().catch(() => {
  console.error('API startup failed. Run pnpm config:check and inspect local service readiness.');
  process.exitCode = 1;
});
