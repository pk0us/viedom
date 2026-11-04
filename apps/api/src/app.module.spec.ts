import { Test } from '@nestjs/testing';
import { AppModule } from './app.module.js';

it('resolves the full application and Mongo driver without a database at startup', async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication();
  try {
    await app.init();
  } finally {
    await app.close();
  }
});
