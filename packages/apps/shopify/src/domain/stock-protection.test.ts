import { stockProtectionSettingsSchema } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import {
  heldQuantity,
  outsideHold,
  type ProtectionCandidate,
  protectionExclusion,
  selectProtection,
} from './stock-protection.js';

const settings = stockProtectionSettingsSchema.parse({
  connectionId: '10000000-0000-4000-8000-000000000001',
  sourceConnectionId: '10000000-0000-4000-8000-000000000002',
});
const candidate: ProtectionCandidate = {
  positionId: 'a',
  skuId: 'sku',
  sku: 'SKU',
  title: null,
  available: 10,
  authority: 9,
  tracked: true,
  inventoryPolicy: 'DENY',
  bundle: false,
  native: false,
  unsettled: false,
  complete: true,
  tags: [],
  collections: [],
  sales24h: null,
};

describe('incident stock protection', () => {
  it('rounds percentage buffers up, respects the larger buffer and never raises stock', () => {
    expect(heldQuantity(10, 9, settings)).toBe(7);
    expect(
      heldQuantity(9, 8, { ...settings, bufferUnits: 0, bufferPercent: 20 }),
    ).toBe(6);
    expect(heldQuantity(1, 20, { ...settings, keepSellable: 5 })).toBe(1);
    expect(heldQuantity(0, 0, settings)).toBe(0);
    expect(heldQuantity(10, 4, settings)).toBe(2);
  });
  it.each([
    [{ inventoryPolicy: 'CONTINUE' }, 'continue_selling'],
    [{ tracked: false }, 'untracked'],
    [{ bundle: true }, 'bundle'],
    [{ bundle: null }, 'eligibility_unknown'],
    [{ native: true }, 'native_stock'],
    [{ unsettled: true }, 'active_correction'],
    [{ complete: false }, 'incomplete'],
    [{ available: null }, 'quantity_unknown'],
    [{ authority: -1 }, 'quantity_unknown'],
    [{ available: 11 }, 'not_at_risk'],
  ] as const)('excludes unsafe or ineligible stock %j', (changes, reason) => {
    expect(protectionExclusion({ ...candidate, ...changes }, settings)).toBe(
      reason,
    );
  });
  it('uses sales rate only when known and enabled, and applies exact SKU, tag and collection exclusions', () => {
    expect(
      protectionExclusion(
        { ...candidate, available: 15, authority: 14, sales24h: 16 },
        { ...settings, includeSalesRate: true },
      ),
    ).toBeNull();
    for (const exclusions of [
      { skus: ['SKU'], tags: [], collections: [] },
      { skus: [], tags: ['sale'], collections: [] },
      { skus: [], tags: [], collections: ['collection'] },
    ])
      expect(
        protectionExclusion(
          { ...candidate, tags: ['sale'], collections: ['collection'] },
          { ...settings, exclusions },
        ),
      ).toBe('excluded');
  });
  it('chooses the highest risk first with stable ties and keeps caps hard', () => {
    const selected = selectProtection(
      [
        { ...candidate, positionId: 'b' },
        { ...candidate, positionId: 'a', available: 3 },
        { ...candidate, positionId: 'c' },
      ],
      { ...settings, maxSkus: 1 },
    );
    expect(selected.map((s) => [s.candidate.positionId, s.reason])).toEqual([
      ['a', null],
      ['b', 'sku_cap'],
      ['c', 'sku_cap'],
    ]);
    expect(
      protectionExclusion(candidate, { ...settings, maxUnitsPerSku: 1 }),
    ).toBe('unit_cap');
  });
  it('relinquishes ownership on sales, returns, manual edits or resumed sync and never infers authorship from equality', () => {
    expect(outsideHold(7, 7, 9)).toBeNull();
    expect(outsideHold(9, 7, 9)).toBe('released_by_sync');
    expect(outsideHold(6, 7, 9)).toBe('changed_outside_luma');
    expect(outsideHold(12, 7, 9)).toBe('changed_outside_luma');
  });
});
