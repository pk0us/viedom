import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig, root } from './config.mjs';
import { cliPath, run, stopChild } from './process.mjs';

loadConfig();
await run(process.execPath, [cliPath('typescript'), '-p', 'packages/contracts/tsconfig.json']);
const api = resolve(root, 'apps/api');
const children = [
  spawn(process.execPath, [cliPath('@nestjs/cli', api), 'start', '--watch'], {
    cwd: api,
    stdio: 'inherit',
    detached: process.platform !== 'win32'
  }),
  spawn(process.execPath, [resolve(root, 'scripts/web-dev.mjs')], {
    cwd: root,
    stdio: 'inherit',
    detached: process.platform !== 'win32'
  })
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  children.forEach(stopChild);
}
for (const child of children) {
  child.once('error', () => stop(1));
  child.once('exit', (code) => stop(code ?? 0));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
