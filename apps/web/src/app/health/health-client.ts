import { httpResource } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import type { HealthResponse, ReadinessResponse } from '@viedom/contracts';
import { publicConfig } from '../../generated/public-config';

export const API_BASE_URL = new InjectionToken<string>('Public-data API base URL', {
  providedIn: 'root',
  factory: () => publicConfig.apiBaseUrl
});

@Injectable({ providedIn: 'root' })
export class HealthClient {
  private readonly base = inject(API_BASE_URL);
  readonly health = httpResource<HealthResponse>(() => ({
    url: `${this.base}/health`,
    timeout: 5000,
    transferCache: false
  }));
  readonly readiness = httpResource<ReadinessResponse>(() => ({
    url: `${this.base}/health/ready`,
    timeout: 5000,
    transferCache: false
  }));

  retry(): void {
    this.health.reload();
    this.readiness.reload();
  }
}
