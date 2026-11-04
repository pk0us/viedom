import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, root } from './config.mjs';
import { generateWeb } from './generate-web.mjs';
import { cliPath, stopChild } from './process.mjs';

const config = loadConfig();
await generateWeb();
const directory = resolve(root, 'apps/web');
const child = spawn(
  process.execPath,
  [
    cliPath('@angular/cli', directory),
    'serve',
    '--host',
    'localhost',
    '--port',
    String(config.ports.web)
  ],
  { cwd: directory, stdio: 'inherit', detached: process.platform !== 'win32' }
);
let timer;
let generation = Promise.resolve();
const watcher = watch(resolve(directory, 'src'), { recursive: true }, (_, file) => {
  if (!file || file.startsWith('generated')) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    generation = generation
      .then(generateWeb)
      .catch(() =>
        console.error('Utility generation failed. Run pnpm --filter @viedom/web prepare:config.')
      );
  }, 150);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    watcher.close();
    clearTimeout(timer);
    stopChild(child);
  });
child.once('error', () => {
  watcher.close();
  process.exitCode = 1;
});
child.once('exit', (code) => {
  watcher.close();
  clearTimeout(timer);
  process.exitCode = code ?? 0;
});
