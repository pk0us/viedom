import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/persistence.spec.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000
  }
});
