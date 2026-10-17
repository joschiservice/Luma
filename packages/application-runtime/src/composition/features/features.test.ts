import { readdir } from 'node:fs/promises';

import { apiContract } from '@luma/api-contract';
import { expect, it } from 'vitest';

it('implements each route area in exactly one feature slice, and every contract area', async () => {
  const files = (await readdir(new URL('.', import.meta.url))).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  );
  const slices = new Map<string, string[]>();
  for (const file of files) {
    const module: Record<string, (services: object) => object> = await import(
      `./${file}`
    );
    // Without services every route is registered and answers as unavailable.
    for (const slice of Object.values(module))
      for (const area of Object.keys(slice({})))
        slices.set(area, [...(slices.get(area) ?? []), file]);
  }

  // The router spreads the slices, so a repeated area would silently replace another.
  expect([...slices].filter(([, owners]) => owners.length > 1)).toEqual([]);
  // `system` closes over the server's draining state, so the HTTP app implements it.
  expect([...slices.keys(), 'system'].sort()).toEqual(
    Object.keys(apiContract).sort(),
  );
});
