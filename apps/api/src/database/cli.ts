import { MikroORM } from '@mikro-orm/mongodb';
import { loadConfig } from '../../../../scripts/config.mjs';
import { localTarget } from './local-target.js';
import { ormOptions } from './orm-options.js';
import { provision } from './provision.js';
import { seed } from './fixtures.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (
    !['indexes', 'seed'].includes(command ?? '') ||
    args.some((arg) => arg !== '--test') ||
    args.length > 1
  ) {
    throw new Error('Usage: db:indexes|db:seed [--test].');
  }
  const target = localTarget(loadConfig(), args.includes('--test'));
  const orm = await MikroORM.init(ormOptions(target.uri, target.dbName));
  try {
    await provision(orm);
    if (command === 'seed') {
      const inserted = await seed(orm);
      console.log(
        `PASS: synthetic fixtures ready (${inserted} inserted; existing records preserved).`
      );
    } else console.log('PASS: reviewed validators and indexes provisioned.');
  } finally {
    await orm.close(true);
  }
}

void main().catch(() => {
  console.error(
    'Database tooling failed. Requires local/dev/test target, ready rs0, valid records and reviewed indexes. Details withheld to protect private data.'
  );
  process.exitCode = 1;
});
