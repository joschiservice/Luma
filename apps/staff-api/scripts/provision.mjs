import { readFile } from 'node:fs/promises';

import { provisionStaffIdentity } from '@luma/staff/composition';

const args = process.argv.slice(2);
try {
  if (args.length !== 2 || args[0] !== '--input')
    throw new Error(
      'Usage: pnpm --filter @luma/staff-api staff:provision --input /secure/path/staff.json',
    );
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      'MIGRATION_DATABASE_URL is required; use administrator credentials outside the running staff API.',
    );
  const input = JSON.parse(await readFile(args[1], 'utf8'));
  await provisionStaffIdentity(databaseUrl, input);
  process.stdout.write('Staff identity admission updated and audited.\n');
} catch {
  process.stderr.write(
    'Staff provisioning failed. Supply a valid --input JSON file and MIGRATION_DATABASE_URL with administrator credentials.\n',
  );
  process.exitCode = 1;
}
