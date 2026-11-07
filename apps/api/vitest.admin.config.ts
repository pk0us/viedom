import { defineConfig } from 'vitest/config';
import base from './vitest.database.config.js';

export default defineConfig({
  ...base,
  test: { ...base.test, include: ['test/admin.spec.ts'] }
});
