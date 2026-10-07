import { readFile, writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { permissionReference } from '../domain/permission-reference.js';

const file = new URL('../../../../docs/permissions.md', import.meta.url);

it('keeps the documented permission reference in sync with the catalog', async () => {
  if (process.env.UPDATE_PERMISSION_REFERENCE)
    await writeFile(file, permissionReference());
  expect(await readFile(file, 'utf8')).toBe(permissionReference());
});
