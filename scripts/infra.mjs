import { resolve } from 'node:path';
import { root, envPath, loadConfig, readEnvironment } from './config.mjs';
import { run } from './process.mjs';

const action = process.argv[2];
try {
  const config = loadConfig();
  if (config.mode === 'production')
    throw new Error('Local infrastructure commands refuse NODE_ENV=production.');
  const common = [
    'compose',
    '--project-name',
    'viedom-local',
    '--project-directory',
    root,
    '--env-file',
    envPath,
    '-f',
    resolve(root, 'compose.yaml')
  ];
  const compose = (...args) => run('docker', [...common, ...args], { env: readEnvironment() });
  if (action === 'up') {
    await compose('up', '-d', 'mongo');
    await compose('run', '--rm', 'mongo-bootstrap');
    await compose('up', '-d', '--wait', '--wait-timeout', '120', 'mongo');
  } else if (action === 'down') await compose('down');
  else if (action === 'logs') await compose('logs', '--tail', '100', '-f', 'mongo');
  else throw new Error('Use up, down or logs.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
