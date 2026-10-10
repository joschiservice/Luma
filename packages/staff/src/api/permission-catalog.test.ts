import { readdir, readFile } from 'node:fs/promises';

import { staffPermissionSchema } from '@luma/api-contract/staff';
import { expect, it } from 'vitest';

import { staffPermissions } from '../domain/access.js';

const migrations = new URL(
  '../../../application-runtime/migrations/',
  import.meta.url,
);

it('keeps the staff permission catalog equal to the contract and the database check', async () => {
  expect(staffPermissionSchema.options).toEqual([...staffPermissions]);
  // The newest migration that redefines the check holds the list the database enforces.
  const files = (await readdir(migrations)).filter((file) =>
    file.endsWith('.sql'),
  );
  let enforced: string[] = [];
  for (const file of files.sort()) {
    const sql = await readFile(new URL(file, migrations), 'utf8');
    const match =
      /ADD CONSTRAINT staff_access_permissions_check CHECK\(permissions <@ ARRAY\[([^\]]+)\]/.exec(
        sql,
      );
    if (match)
      enforced = [...match[1]!.matchAll(/'([^']+)'/g)].map((item) => item[1]!);
  }
  expect(enforced).toEqual([...staffPermissions]);
});
