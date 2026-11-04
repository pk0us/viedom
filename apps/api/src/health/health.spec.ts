import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/mongodb';
import { HealthService } from './health.service.js';
import { HealthController } from './health.controller.js';
import { ApiErrorFilter } from '../api-error.filter.js';
import type { INestApplication } from '@nestjs/common';

describe('health HTTP contract and constructor metadata', () => {
  let app: INestApplication;
  let base: string;
  const command = vi.fn();

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        {
          provide: MikroORM,
          useValue: { em: { getConnection: () => ({ getDb: () => ({ command }) }) } }
        }
      ]
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new ApiErrorFilter());
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    command.mockReset();
  });
  afterEach(async () => {
    await app.close();
  });

  it('liveness does not depend on the database', async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'viedom-api' });
    expect(command).not.toHaveBeenCalled();
  });
  it('is ready only for an authenticated writable replica-set primary', async () => {
    command
      .mockResolvedValueOnce({ authInfo: { authenticatedUsers: [{ user: 'test' }] } })
      .mockResolvedValueOnce({ isWritablePrimary: true, setName: 'rs0' });
    const response = await fetch(`${base}/api/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
  });
  it.each([{ isWritablePrimary: false, setName: 'rs0' }, { isWritablePrimary: true }])(
    'rejects a secondary or standalone database',
    async (hello) => {
      command
        .mockResolvedValueOnce({ authInfo: { authenticatedUsers: [{ user: 'test' }] } })
        .mockResolvedValueOnce(hello);
      const response = await fetch(`${base}/api/health/ready`);
      expect(response.status).toBe(503);
    }
  );
  it('does not disclose database errors', async () => {
    command.mockRejectedValue(new Error('SYNTHETIC_DATABASE_SECRET'));
    const response = await fetch(`${base}/api/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  });
  it('returns the safe shared error envelope', async () => {
    const response = await fetch(`${base}/api/missing`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Resource not found.', requestId: expect.any(String) }
    });
  });
});
