import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthResponse, ReadinessResponse } from '@viedom/contracts';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  health(): HealthResponse {
    return this.healthService.health();
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async readiness(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    const readiness = await this.healthService.readiness();
    response.status(readiness.status === 'ready' ? 200 : 503);
    return readiness;
  }
}
