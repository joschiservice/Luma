import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readStaffSettings, seedLocalStaff } from '@luma/staff/composition';

import { stateDirectory } from './environment.mjs';

/** Seeds the worktree's isolated staff identity and stores credentials in ignored local state. */
export async function seedStaff(
  saved,
  env,
  migrationUrl,
  outputDirectory = stateDirectory,
) {
  const email = 'staff@example.test';
  await seedLocalStaff(
    readStaffSettings({ ...env, NODE_ENV: 'development' }),
    {
      email,
      name: 'Local support operator',
      password: saved.staffSeedPassword,
      permissions: [
        'staff.directory.read',
        'staff.workspace.inspect',
        'staff.sessions.revoke',
        'staff.accounts.inspect',
      ],
    },
    migrationUrl,
  );
  await writeFile(
    join(outputDirectory, 'staff.json'),
    `${JSON.stringify(
      {
        email,
        password: saved.staffSeedPassword,
        origin: env.STAFF_PUBLIC_ORIGIN,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}
