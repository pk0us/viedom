import { loadConfig } from './config.mjs';
try {
  loadConfig();
  console.log('PASS: root configuration is valid (values withheld).');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
