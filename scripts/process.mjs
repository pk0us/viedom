import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { root } from './config.mjs';

const rootRequire = createRequire(new URL('../package.json', import.meta.url));
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${code ?? 'signal'}).`))
    );
  });
}

// Node entry points avoid Windows shell quoting and orphaned pnpm.cmd processes.
export function cliPath(packageName, directory = root) {
  const require = directory === root ? rootRequire : createRequire(`${directory}/package.json`);
  const file = require.resolve(`${packageName}/package.json`);
  const manifest = require(file);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin)[0];
  return resolve(dirname(file), bin);
}

export function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32')
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}
