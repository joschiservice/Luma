import { describe, expect, it } from 'vitest';

import {
  citedReads,
  completeReads,
  type ReturnRead,
  returnReadEvidence,
} from './return-reads.js';

const read = (
  id: string,
  completeness: ReturnRead['completeness'] = 'complete',
): ReturnRead => ({
  id,
  source: {
    provider: 'jtl',
    connectionId: 'wawi',
    resource: 'sku',
    externalId: 'item',
    scopeKey: 'warehouse',
  },
  observedAt: '2026-10-12T12:00:00Z',
  sourceUpdatedAt: null,
  sourceRevision: null,
  adapterVersion: 'jtl-wawi/2.2',
  completeness,
  data: { onHand: '12' },
});

describe('citedReads', () => {
  it('returns each cited read once, in reference order', () => {
    const a = read('a'),
      b = read('b');
    expect(citedReads(['b', 'a', 'b'], [a, b, read('unused')])).toEqual([b, a]);
  });

  it('refuses references without a read, so they are never cited', () => {
    expect(citedReads(['a', 'missing'], [read('a')])).toBeNull();
    expect(citedReads([], [])).toEqual([]);
  });
});

describe('completeReads', () => {
  it('is false when any read is partial', () => {
    expect(completeReads([read('a'), read('b')])).toBe(true);
    expect(completeReads([read('a'), read('b', 'partial')])).toBe(false);
  });
});

describe('returnReadEvidence', () => {
  it('keeps the read with the case and the subject that cited it', () => {
    expect(
      returnReadEvidence(
        'tenant',
        'case',
        { purpose: 'settlement', id: 'settlement' },
        read('a', 'partial'),
      ),
    ).toEqual({
      ...read('a', 'partial'),
      tenantId: 'tenant',
      caseId: 'case',
      purpose: 'settlement',
      subjectId: 'settlement',
    });
  });
});
