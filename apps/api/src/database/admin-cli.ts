import { loadConfig } from '../../../../scripts/config.mjs';
import { localTarget } from './local-target.js';
import { initializeOrm, ormOptions } from './orm-options.js';
import { provision } from './provision.js';
import { provisionFirstAdmin } from './admin-provision.js';

async function main(): Promise<void> {
  const [id, email, acknowledgement, ...args] = process.argv.slice(2);
  if (
    !id ||
    !email ||
    acknowledgement !== '--acknowledge-admin-access' ||
    args.length > 1 ||
    args.some((arg) => arg !== '--test')
  )
    throw new Error(
      'Usage: db:admin <existing-account-id> <exact-normalized-email> --acknowledge-admin-access [--test].'
    );
  const target = localTarget(loadConfig(), args.includes('--test'));
  const orm = await initializeOrm(ormOptions(target.uri, target.dbName));
  try {
    await provision(orm);
    await provisionFirstAdmin(orm, id, email);
    console.log('PASS: first administrator provisioned; operator grant evidence recorded.');
  } finally {
    await orm.close(true);
  }
}

void main().catch(() => {
  console.error(
    'Administrator provisioning refused or failed. Requires acknowledged exact active verified nonfixture account, no existing administrator/grant and a guarded local/test database. Details withheld.'
  );
  process.exitCode = 1;
});
