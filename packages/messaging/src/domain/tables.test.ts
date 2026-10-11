import { describe, expect, it } from 'vitest';

import { lookupKeys, matchFact } from './matching.js';
import { parseDate, parseDecimal, parseMoney, tableFacts } from './tables.js';

describe('number and date reading', () => {
  it('reads English and German decimals and flags ambiguous ones', () => {
    expect(parseDecimal('1.234,50')).toEqual({
      value: '1234.5',
      ambiguous: false,
    });
    expect(parseDecimal('1,234.50')).toEqual({
      value: '1234.5',
      ambiguous: false,
    });
    expect(parseDecimal('12,5')).toEqual({ value: '12.5', ambiguous: false });
    expect(parseDecimal('1,500')).toEqual({ value: '1.5', ambiguous: true });
    expect(parseDecimal('007')).toEqual({ value: '7', ambiguous: false });
    expect(parseDecimal('abc')).toBeNull();
    expect(parseMoney('12,50 €', null)).toEqual({
      amount: '12.5',
      currency: 'EUR',
      ambiguous: false,
    });
    expect(parseMoney('3.10', 'CHF')).toMatchObject({ currency: 'CHF' });
  });

  it('reads ISO and German dates', () => {
    expect(parseDate('2026-10-20')).toEqual({
      date: '2026-10-20',
      ambiguous: false,
    });
    expect(parseDate('20.10.2026')).toEqual({
      date: '2026-10-20',
      ambiguous: false,
    });
    expect(parseDate('5.1.26')).toEqual({
      date: '2026-01-05',
      ambiguous: false,
    });
    expect(parseDate('05/01/2026')).toEqual({
      date: '2026-01-05',
      ambiguous: true,
    });
    expect(parseDate('31.02.2026')).toBeNull();
  });
});

describe('table facts', () => {
  const schedule = {
    name: 'Lieferplan-PO-1001',
    rows: [
      ['Lieferant GmbH', '', '', '', '', ''],
      ['Bestellnummer:', 'PO-1001', '', '', '', ''],
      ['', '', '', '', '', ''],
      [
        'Bestellung',
        'Artikelnummer',
        'Bezeichnung',
        'Bestellt',
        'Menge',
        'Liefertermin',
      ],
      ['PO-1001', 'SKU-1', 'Widget', '10', '6', '20.10.2026'],
      ['PO-1001', 'SKU-1', 'Widget', '10', '4', '27.10.2026'],
      ['PO-1001', 'SKU-2', 'Gadget', '5', '1,500', ''],
    ],
  };

  it('reads lines, dates and references with their cells', () => {
    const facts = tableFacts([schedule]);
    const lines = facts.filter((f) => f.value.kind === 'line');

    expect(lines.map((f) => f.value)).toEqual([
      {
        kind: 'line',
        sku: 'SKU-1',
        description: 'Widget',
        quantity: '6',
        unit: null,
        unitPrice: null,
      },
      {
        kind: 'line',
        sku: 'SKU-1',
        description: 'Widget',
        quantity: '4',
        unit: null,
        unitPrice: null,
      },
      {
        kind: 'line',
        sku: 'SKU-2',
        description: 'Gadget',
        quantity: '1.5',
        unit: null,
        unitPrice: null,
      },
    ]);
    expect(lines[0]!.locator).toEqual({
      kind: 'cells',
      sheet: 'Lieferplan-PO-1001',
      row: 5,
      rowEnd: 5,
      column: 2,
      columnEnd: 5,
    });
    expect(lines[0]!.quote).toBe('SKU-1\tWidget\t10\t6');
    expect(lines.map((f) => f.confidence)).toEqual(['high', 'high', 'low']);
    expect(
      facts.filter((f) => f.value.kind === 'date').map((f) => f.value),
    ).toEqual([
      { kind: 'date', role: 'delivery', date: '2026-10-20' },
      { kind: 'date', role: 'delivery', date: '2026-10-27' },
    ]);
    const references = facts.filter((f) => f.value.kind === 'reference');
    expect(references.map((f) => [f.value, f.locator])).toEqual([
      [
        { kind: 'reference', role: 'purchase_order', text: 'PO-1001' },
        {
          kind: 'cells',
          sheet: 'Lieferplan-PO-1001',
          row: 2,
          rowEnd: 2,
          column: 1,
          columnEnd: 2,
        },
      ],
    ]);
  });

  it('reads English headers with prices and currencies', () => {
    const facts = tableFacts([
      {
        name: 'Sheet1',
        rows: [
          [
            'Item number',
            'Description',
            'Qty',
            'Unit',
            'Unit price',
            'Currency',
          ],
          ['A-1', 'Cable', '12 pcs', '', '3.10', 'EUR'],
          ['A-2', 'Plug', '2', 'box', '1.234,00', ''],
        ],
      },
    ]);

    expect(facts.map((f) => [f.value, f.confidence])).toEqual([
      [
        {
          kind: 'line',
          sku: 'A-1',
          description: 'Cable',
          quantity: '12',
          unit: 'pcs',
          unitPrice: { amount: '3.1', currency: 'EUR' },
        },
        'high',
      ],
      [
        {
          kind: 'line',
          sku: 'A-2',
          description: 'Plug',
          quantity: '2',
          unit: 'box',
          unitPrice: { amount: '1234', currency: 'EUR' },
        },
        'high',
      ],
    ]);
  });

  it('reads nothing from sheets without a table header', () => {
    expect(tableFacts([{ name: 'Notes', rows: [['hello', 'world']] }])).toEqual(
      [],
    );
  });
});

describe('matching', () => {
  const lookups = {
    skus: new Set(['SKU-1']),
    references: [
      { kind: 'purchase_order' as const, id: 'po-1', key: 'PO-1001' },
      { kind: 'purchase_order' as const, id: 'a', key: 'AMB-77' },
      { kind: 'purchase_order' as const, id: 'b', key: 'AMB-77' },
      { kind: 'order' as const, id: 'o-1', key: '#1001' },
    ],
    customers: [{ email: 'kim@customer.example', id: 'c-1' }],
    suppliers: [
      { id: 's-1', key: 'acme gmbh' },
      { id: 's-2', key: 'twin ag' },
      { id: 's-3', key: 'twin ag' },
    ],
    ruleSuppliers: ['s-3'],
  };

  it('matches exactly one record and lists several as ambiguous', () => {
    expect(
      matchFact(
        { kind: 'reference', role: 'purchase_order', text: ' po-1001' },
        lookups,
      ),
    ).toEqual({
      state: 'matched',
      record: { kind: 'purchase_order', id: 'po-1' },
      candidates: [],
    });
    expect(
      matchFact(
        { kind: 'reference', role: 'purchase_order', text: 'AMB-77' },
        lookups,
      ),
    ).toEqual({
      state: 'ambiguous',
      record: null,
      candidates: [
        { kind: 'purchase_order', id: 'a' },
        { kind: 'purchase_order', id: 'b' },
      ],
    });
    expect(
      matchFact({ kind: 'reference', role: 'order', text: 'PO-1001' }, lookups)
        .state,
    ).toBe('unmatched');
    expect(
      matchFact({ kind: 'reference', role: 'invoice', text: 'R-1' }, lookups)
        .state,
    ).toBe('not_applicable');
  });

  it('matches SKUs to the catalog and parties to suppliers and customers', () => {
    const line = {
      kind: 'line' as const,
      sku: 'sku-1',
      description: null,
      quantity: '1',
      unit: null,
      unitPrice: null,
    };
    expect(matchFact({ ...line, sku: ' sku-1' }, lookups).state).toBe(
      'matched',
    );
    expect(matchFact({ ...line, sku: 'SKU-9' }, lookups).state).toBe(
      'unmatched',
    );
    const supplier = (name: string) =>
      matchFact(
        { kind: 'party', role: 'supplier', name, email: null },
        lookups,
      );
    expect(supplier('ACME GmbH ').record).toEqual({
      kind: 'supplier',
      id: 's-1',
    });
    // The mailbox rule's supplier decides between equal names.
    expect(supplier('Twin AG').record).toEqual({ kind: 'supplier', id: 's-3' });
    // A name no supplier has falls back to the rule's supplier.
    expect(supplier('Someone else').record).toEqual({
      kind: 'supplier',
      id: 's-3',
    });
    expect(
      matchFact(
        {
          kind: 'party',
          role: 'customer',
          name: 'Kim',
          email: 'Kim@Customer.example',
        },
        lookups,
      ).record,
    ).toEqual({ kind: 'customer', id: 'c-1' });
    expect(
      lookupKeys([
        { ...line, sku: ' a b ' },
        { kind: 'reference', role: 'order', text: ' #1001 ' },
        { kind: 'party', role: 'supplier', name: 'Acme GmbH', email: null },
      ]),
    ).toEqual({
      skus: ['A B'],
      references: ['#1001'],
      emails: [],
      supplierNames: ['acme gmbh'],
    });
  });
});
