import { describe, expect, it } from 'vitest';

import type { Representation } from './documents.js';
import type { FactDocument, FactMatch, FactValue } from './facts.js';
import {
  compareFacts,
  comparisonKeys,
  initialStatus,
  locateQuote,
  quoteAt,
  removedFacts,
  reviewFact,
  validValue,
} from './facts.js';
import { documentFamily } from './threads.js';

const line = (sku: string, quantity: string): FactValue => ({
  kind: 'line',
  sku,
  description: null,
  quantity,
  unit: null,
  unitPrice: null,
});
const delivery = (date: string): FactValue => ({
  kind: 'date',
  role: 'delivery',
  date,
});
const matched: FactMatch = { state: 'matched', record: null, candidates: [] };
const ambiguous: FactMatch = {
  state: 'ambiguous',
  record: null,
  candidates: [
    { kind: 'purchase_order', id: 'a' },
    { kind: 'purchase_order', id: 'b' },
  ],
};

const document = (
  value: FactValue,
  match: FactMatch = matched,
): FactDocument => ({
  value,
  locator: { kind: 'text', page: null, start: 0, end: 4 },
  quote: 'text',
  confidence: 'high',
  match,
  origin: 'model',
  change: null,
  review: null,
});

describe('document versions', () => {
  it('groups renamed versions of a file and keeps other files apart', () => {
    for (const name of [
      'Lieferplan PO-1001 v2.csv',
      'lieferplan_po-1001 (1).csv',
      'Lieferplan-PO-1001 2026-10-11.csv',
      'Lieferplan PO-1001 final.csv',
    ])
      expect(documentFamily(name, 't')).toBe(
        documentFamily('Lieferplan-PO-1001.csv', 't'),
      );
    expect(documentFamily('AB-10023456.pdf', 't')).not.toBe(
      documentFamily('AB-10023457.pdf', 't'),
    );
    expect(documentFamily('renew.pdf', 't')).toBe('renew.pdf:t');
  });

  it('numbers repeated keys so schedules compare line by line', () => {
    expect(
      comparisonKeys([
        line('SKU-1', '6'),
        line(' sku-1 ', '4'),
        delivery('2026-10-20'),
        delivery('2026-10-27'),
      ]),
    ).toEqual([
      'line:SKU-1',
      'line:SKU-1#2',
      'date:delivery',
      'date:delivery#2',
    ]);
  });

  it('marks new, changed and unchanged facts and carries earlier reviews', () => {
    const review = {
      outcome: 'corrected' as const,
      by: 'u1',
      at: '2026-10-01T00:00:00.000Z',
      original: line('SKU-1', '9'),
    };
    const previous = [
      { value: line('SKU-1', '10'), status: 'confirmed' as const, review },
      { value: line('SKU-2', '5'), status: 'proposed' as const, review: null },
      {
        value: delivery('2026-10-20'),
        status: 'proposed' as const,
        review: null,
      },
      {
        value: line('SKU-9', '1'),
        status: 'rejected' as const,
        review: { ...review, outcome: 'rejected' as const, original: null },
      },
    ];
    const current = [
      { value: line('SKU-1', '10') },
      { value: line('SKU-2', '4') },
      { value: delivery('2026-10-20') },
      { value: line('SKU-3', '1') },
      { value: line('SKU-9', '2') },
    ];
    const compared = compareFacts(current, previous);

    expect(compared.map((c) => c.change)).toEqual([
      'unchanged',
      'changed',
      'unchanged',
      'new',
      'new',
    ]);
    expect(compared[0]!.carried).toMatchObject({
      status: 'confirmed',
      review: { outcome: 'confirmed', by: 'u1', original: null },
    });
    expect(compared[2]!.carried).toBeNull();
    expect(compareFacts(current, null).every((c) => c.change === null)).toBe(
      true,
    );
    expect(
      removedFacts([{ value: line('SKU-1', '10') }], previous).map(
        (f) => f.value,
      ),
    ).toEqual([line('SKU-2', '5'), delivery('2026-10-20')]);
  });
});

describe('fact review', () => {
  it('needs a correction for uncertain or ambiguous facts', () => {
    expect(initialStatus('high', matched)).toBe('proposed');
    expect(initialStatus('low', matched)).toBe('needs_correction');
    expect(initialStatus('high', ambiguous)).toBe('needs_correction');
  });

  it('confirms only facts that need no correction', () => {
    const reference: FactValue = {
      kind: 'reference',
      role: 'purchase_order',
      text: 'AMB-77',
    };
    const blocked = {
      status: 'needs_correction' as const,
      document: document(reference, ambiguous),
    };
    expect(reviewFact(blocked, { outcome: 'confirm' }, 'u', 'now')).toEqual({
      ok: false,
      refusal: 'needs_correction',
    });
    expect(
      reviewFact(
        blocked,
        { outcome: 'correct', value: reference, match: ambiguous },
        'u',
        'now',
      ),
    ).toEqual({ ok: false, refusal: 'needs_correction' });
    const chosen: FactMatch = {
      state: 'matched',
      record: { kind: 'purchase_order', id: 'b' },
      candidates: [],
    };
    const corrected = reviewFact(
      blocked,
      { outcome: 'correct', value: reference, match: chosen },
      'u',
      'now',
    );
    expect(corrected).toMatchObject({
      ok: true,
      status: 'confirmed',
      document: {
        match: chosen,
        review: { outcome: 'corrected', by: 'u', original: reference },
      },
    });
    expect(
      reviewFact(
        blocked,
        { outcome: 'correct', value: delivery('2026-10-20'), match: matched },
        'u',
        'now',
      ),
    ).toEqual({ ok: false, refusal: 'kind_changed' });
    expect(
      reviewFact(blocked, { outcome: 'reject' }, 'u', 'now'),
    ).toMatchObject({ ok: true, status: 'rejected' });
    expect(
      reviewFact(
        { status: 'confirmed', document: document(reference) },
        { outcome: 'reject' },
        'u',
        'now',
      ),
    ).toEqual({ ok: false, refusal: 'already_reviewed' });
  });

  it('checks values against the contract bounds', () => {
    expect(validValue(delivery('2026-02-30'))).toBe(false);
    expect(validValue(line('SKU-1', '1.5'))).toBe(true);
    expect(validValue(line('SKU-1', '-1'))).toBe(false);
    expect(
      validValue({
        kind: 'line',
        sku: null,
        description: null,
        quantity: '1',
        unit: null,
        unitPrice: null,
      }),
    ).toBe(false);
  });
});

describe('locating facts', () => {
  const text: Representation = {
    kind: 'text',
    pages: ['Order PO-1001\nDelivery: 20.10.2026', 'Total  EUR\n 120.00'],
  };
  const sheets: Representation = {
    kind: 'sheets',
    sheets: [
      {
        name: 'Plan',
        rows: [
          ['SKU', 'Qty'],
          ['SKU-1', '6'],
        ],
      },
    ],
  };

  it('reads quotes only from inside the document', () => {
    expect(quoteAt(text, { kind: 'text', page: 1, start: 6, end: 13 })).toBe(
      'PO-1001',
    );
    expect(
      quoteAt(text, { kind: 'text', page: 3, start: 0, end: 1 }),
    ).toBeNull();
    expect(
      quoteAt(text, { kind: 'text', page: 1, start: 30, end: 90 }),
    ).toBeNull();
    // Paged documents need a page.
    expect(
      quoteAt(text, { kind: 'text', page: null, start: 0, end: 5 }),
    ).toBeNull();
    expect(
      quoteAt(sheets, {
        kind: 'cells',
        sheet: 'Plan',
        row: 2,
        rowEnd: 2,
        column: 1,
        columnEnd: 2,
      }),
    ).toBe('SKU-1\t6');
    expect(
      quoteAt(sheets, {
        kind: 'cells',
        sheet: 'Plan',
        row: 2,
        rowEnd: 3,
        column: 1,
        columnEnd: 1,
      }),
    ).toBeNull();
  });

  it('finds quotes exactly or across whitespace, and drops missing ones', () => {
    expect(locateQuote(text, 'Delivery: 20.10.2026', { page: 2 })).toEqual({
      locator: { kind: 'text', page: 1, start: 14, end: 34 },
      quote: 'Delivery: 20.10.2026',
    });
    expect(locateQuote(text, 'Total EUR 120.00')).toEqual({
      locator: { kind: 'text', page: 2, start: 0, end: 18 },
      quote: 'Total  EUR\n 120.00',
    });
    expect(locateQuote(text, 'PO-2002')).toBeNull();
    expect(
      locateQuote(sheets, 'SKU-1', { sheet: 'Plan', row: 2, column: 1 }),
    ).toMatchObject({
      locator: { kind: 'cells', sheet: 'Plan', row: 2, column: 1 },
      quote: 'SKU-1',
    });
  });
});
