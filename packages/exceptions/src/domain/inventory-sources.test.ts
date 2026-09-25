import { describe, expect, it } from 'vitest';

import type { DiagnosisInput } from './diagnosis.js';
import { inventorySources } from './inventory-sources.js';

function snapshot() {
  return {
    input: {
      exceptionClass: 'inventory_mismatch',
      facts: {
        tenantId: 'tenant',
        connectionIds: ['wawi', 'store'],
        evidenceRefs: ['a', 'b'],
      },
    },
    evidence: [
      {
        key: 'b',
        tenantId: 'tenant',
        connectionId: 'store',
        source: { provider: 'shopify' },
      },
      {
        key: 'a',
        tenantId: 'tenant',
        connectionId: 'wawi',
        source: { provider: 'jtl-onprem' },
      },
    ],
  } as DiagnosisInput;
}

describe('inventory source labels', () => {
  it('binds names to recorded sides even when evidence is reversed', () => {
    expect(inventorySources(snapshot())).toEqual({
      left: 'jtl-onprem',
      right: 'shopify',
    });
  });
  it('does not infer a missing source from the remaining evidence', () => {
    const item = snapshot();
    item.evidence.pop();
    expect(inventorySources(item)).toEqual({ left: null, right: 'shopify' });
  });
  it('rejects evidence outside the recorded tenant or reference set', () => {
    const item = snapshot();
    item.evidence[0]!.tenantId = 'other';
    item.evidence[1]!.key = 'unrelated';
    expect(inventorySources(item)).toEqual({ left: null, right: null });
  });
  it('leaves ambiguous connections unnamed', () => {
    const item = snapshot();
    item.evidence.push({
      ...item.evidence[0]!,
      source: { ...item.evidence[0]!.source!, provider: 'other' },
    });
    expect(inventorySources(item)?.right).toBeNull();
  });
  it('handles absent historical snapshots', () =>
    expect(inventorySources(null)).toBeNull());
});
