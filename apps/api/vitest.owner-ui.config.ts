import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/owner-ui.spec.ts'],
    fileParallelism: false,
    testTimeout: 90000,
    hookTimeout: 30000
  }
});
