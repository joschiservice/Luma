import { expect, it, vi } from 'vitest';

import { assertCellRegion } from './cell-region.js';

it.each(['AU', 'EU', 'US'] as const)(
  'requires a provisioned matching %s cell before startup',
  async (region) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ region }] });
    await expect(assertCellRegion({ query }, region)).resolves.toBeUndefined();
    query.mockResolvedValue({
      rows: [{ region: region === 'AU' ? 'EU' : 'AU' }],
    });
    await expect(assertCellRegion({ query }, region)).rejects.toThrow(
      'LUMA_REGION',
    );
    query.mockResolvedValue({ rows: [] });
    await expect(assertCellRegion({ query }, region)).rejects.toThrow(
      'LUMA_REGION',
    );
  },
);
