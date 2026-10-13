import type { SqlTransaction } from '@luma/platform';
import { expect, it } from 'vitest';

import { readPurchasingActionTimeline } from './purchasing-timeline.js';

it('never reads stock actions without inventory access and binds every lookup to the tenant', async () => {
  const calls: { sql: string; values?: unknown[] | undefined }[] = [];
  const query: SqlTransaction['query'] = async (sql, values) => {
    calls.push({ sql, values });

    return { rows: [], rowCount: 0 };
  };
  expect(
    await readPurchasingActionTimeline({ query }, 'tenant', 'order', false),
  ).toEqual([]);
  expect(
    calls.some((call) => call.sql.includes('shopify_inventory_corrections')),
  ).toBe(false);
  for (const call of calls) expect(call.values?.[0]).toBe('tenant');
});
