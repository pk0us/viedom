import { resolve } from 'node:path';
import { loadConfig, root } from './config.mjs';
import { run, cliPath } from './process.mjs';

if (loadConfig().mode === 'production') throw new Error('Local media smoke refuses production.');
await run(process.execPath, [cliPath('typescript'), '-p', 'packages/contracts/tsconfig.json']);
const directory = resolve(root, 'apps/api');
await run(
  process.execPath,
  [cliPath('vitest', directory), 'run', '--config', 'vitest.media.config.ts'],
  { cwd: directory }
);
