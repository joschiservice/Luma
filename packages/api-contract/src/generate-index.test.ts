import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { renderIndex } from './generate-index.js';

it('keeps the generated root export synchronized with the schema modules and route groups', async () => {
  // Run `pnpm --filter @luma/api-contract generate:index` when this fails.
  expect(await readFile(new URL('generated.ts', import.meta.url), 'utf8')).toBe(
    await renderIndex(),
  );
});
