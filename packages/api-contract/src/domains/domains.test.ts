import { readdir } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { apiContract } from '../index.js';

it('puts each route area in exactly one package group, and every group in the contract', async () => {
  const files = (await readdir(new URL('.', import.meta.url))).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  );
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const module: Record<string, object> = await import(`./${file}`);
    for (const group of Object.values(module))
      for (const area of Object.keys(group))
        groups.set(area, [...(groups.get(area) ?? []), file]);
  }

  // The contract spreads the groups, so a repeated area would silently replace another.
  expect([...groups].filter(([, owners]) => owners.length > 1)).toEqual([]);
  expect([...groups.keys(), 'system'].sort()).toEqual(
    Object.keys(apiContract).sort(),
  );
});
