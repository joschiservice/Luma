import { importedReads } from '@luma/connections';
import { expect, it } from 'vitest';

import { recordCapabilities } from '../domain/streams.js';

it('imports exactly the reads connection health waits for', () => {
  expect(
    Object.fromEntries(
      Object.entries(recordCapabilities).map(([type, read]) => [read, type]),
    ),
  ).toEqual(importedReads);
});
