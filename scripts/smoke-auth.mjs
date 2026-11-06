import { resolve } from 'node:path';
import { loadConfig, root } from './config.mjs';
import { run, cliPath } from './process.mjs';
import { generateWeb } from './generate-web.mjs';

if (loadConfig().mode === 'production') throw new Error('Local auth smoke refuses production.');
const apiDirectory = resolve(root, 'apps/api');
const webDirectory = resolve(root, 'apps/web');
await run(process.execPath, [cliPath('typescript'), '-p', 'packages/contracts/tsconfig.json']);
await generateWeb();
await run(process.execPath, [cliPath('@angular/cli', webDirectory), 'build'], {
  cwd: webDirectory
});
await run(
  process.execPath,
  [cliPath('vitest', apiDirectory), 'run', '--config', 'vitest.auth-ui.config.ts'],
  { cwd: apiDirectory }
);
