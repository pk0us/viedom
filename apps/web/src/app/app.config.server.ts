import { mergeApplicationConfig } from '@angular/core';
import type { ApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';
import { API_BASE_URL } from './health/health-client';
import { serverConfig } from '../generated/server-config';

const server: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    { provide: API_BASE_URL, useValue: serverConfig.apiBaseUrl }
  ]
};
export const config = mergeApplicationConfig(appConfig, server);
