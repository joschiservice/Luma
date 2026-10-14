import { describe, expect, it } from 'vitest';

import { exportCsv } from './exports.js';

describe('list exports', () => {
  it('writes readable cells and never lets a spreadsheet run cell text', () => {
    expect(
      exportCsv(
        [
          { id: 'number', label: 'Order' },
          { id: 'total', label: 'Total' },
          { id: 'tags', label: 'Tags' },
          { id: 'note', label: 'Note, internal' },
        ],
        [
          {
            number: '#1001',
            total: { amount: '48.00', currency: 'EUR' },
            tags: ['vip', 'rush'],
            note: '=HYPERLINK("x")',
          },
          { number: '#1002', total: null, tags: [], note: undefined },
        ],
        'Cut off at 5,000 rows.',
      ),
    ).toBe(
      'Order,Total,Tags,"Note, internal"\r\n' +
        `#1001,48.00 EUR,"vip; rush","'=HYPERLINK(""x"")"\r\n` +
        '#1002,,,\r\n' +
        '"Cut off at 5,000 rows."\r\n',
    );
  });
});
