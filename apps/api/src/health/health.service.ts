import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mongodb';
import type { HealthResponse, ReadinessResponse } from '@viedom/contracts';

@Injectable()
export class HealthService {
  constructor(private readonly orm: MikroORM) {}

  health(): HealthResponse {
    return { status: 'ok', service: 'viedom-api' };
  }

  async readiness(): Promise<ReadinessResponse> {
    try {
      const db = this.orm.em.getConnection().getDb();
      const options = { timeoutMS: 3000 };
      const authentication = await db.command({ connectionStatus: 1 }, options);
      const hello = await db.command({ hello: 1 }, options);
      if (
        authentication['authInfo']?.authenticatedUsers?.length &&
        hello['isWritablePrimary'] &&
        hello['setName']
      )
        return { status: 'ready' };
    } catch {
      /* Public readiness never exposes driver errors or configuration. */
    }
    return { status: 'not_ready' };
  }
}
