import type { ThreadEvent } from '@luma/api-contract';
import { textSegments } from '@luma/ui/components/primitives/source-view';
import { describe, expect, it } from 'vitest';

import { cellText, onPage, pickLocator } from './document';
import { documentFixture } from './fixtures';
import {
  addressLabel,
  cellRange,
  confirmBlock,
  correspondentLabel,
  dueState,
  eventText,
  factText,
  groupFacts,
} from './presentation';

describe('inbox presentation', () => {
  it('labels reply deadlines in text, never by color alone', () => {
    const thread = {
      replyDueAt: '2026-10-08T09:00:00.000Z',
      overdue: true,
      status: 'open' as const,
    };
    expect(dueState(thread)).toBe('overdue');
    expect(dueState({ ...thread, overdue: false })).toBe('due');
    expect(dueState({ ...thread, status: 'closed' })).toBe('none');
    expect(dueState({ ...thread, replyDueAt: null })).toBe('none');
  });

  it('reads fact values as one line', () => {
    expect(
      factText({
        kind: 'line',
        sku: 'LAMP-01',
        description: null,
        quantity: '120',
        unit: 'pcs',
        unitPrice: { amount: '14.50', currency: 'EUR' },
      }),
    ).toBe('120 pcs × LAMP-01 at €14.50');
    expect(
      factText({
        kind: 'line',
        sku: null,
        description: null,
        quantity: '3',
        unit: null,
        unitPrice: null,
      }),
    ).toBe('3 × Unnamed item');
    expect(
      factText({ kind: 'date', role: 'delivery', date: '2026-10-21' }),
    ).toBe('21 Oct 2026');
  });

  it('names erased contacts instead of showing an empty address', () => {
    const erased = { address: '', name: null };
    expect(addressLabel(erased)).toBe('Erased contact');
    expect(correspondentLabel({ correspondent: erased })).toBe(
      'Erased contact',
    );
    expect(
      factText({ kind: 'party', role: 'customer', name: '', email: null }),
    ).toBe('Erased contact');
  });

  it('groups facts by kind in a fixed order and blocks unchanged confirmation of uncertain facts', () => {
    expect(
      groupFacts(documentFixture.facts).map((group) => group.kind),
    ).toEqual(['party', 'reference', 'line', 'date']);
    expect(confirmBlock({ status: 'needs_correction' })).toMatch(/correct/);
    expect(confirmBlock({ status: 'confirmed' })).toMatch(/already/);
    expect(confirmBlock({ status: 'proposed' })).toBeUndefined();
  });

  it('describes timeline events from optional details', () => {
    const event = (
      type: ThreadEvent['type'],
      details: Record<string, string> = {},
    ): ThreadEvent => ({
      id: '13131313-0000-4000-8000-000000000001',
      type,
      actor: { kind: 'luma', id: 'luma' },
      details,
      occurredAt: '2026-10-07T09:00:00.000Z',
    });
    const helpers = { name: () => 'Sam', date: () => '8 Oct 2026 11:00' };
    expect(eventText(event('assigned', { ownerId: 'x' }), helpers)).toBe(
      'Assigned to Sam',
    );
    expect(eventText(event('assigned'), helpers)).toBe('Owner removed');
    expect(
      eventText(event('status_changed', { status: 'bogus' }), helpers),
    ).toBe('Status changed');
    expect(eventText(event('handed_off', { record: 'PO-1' }), helpers)).toBe(
      'Recorded on PO-1',
    );
    expect(
      eventText(event('handed_off', { outcome: 'truncated' }), helpers),
    ).toBe(
      'Not recorded on the purchase order: the message text is incomplete',
    );
    expect(eventText(event('deadline_set'), helpers)).toBe(
      'Reply deadline set to automatic',
    );
  });

  it('names cell ranges and converts source picks to locators', () => {
    expect(
      cellRange({ sheet: 'A', row: 2, rowEnd: 2, column: 1, columnEnd: 1 }),
    ).toBe('A2');
    expect(
      cellRange({ sheet: 'A', row: 2, rowEnd: 4, column: 27, columnEnd: 28 }),
    ).toBe('AA2:AB4');
    expect(
      cellText(
        [
          ['a', 'b', 'c'],
          ['d', 'e', 'f'],
        ],
        { row: 1, rowEnd: 2, column: 2, columnEnd: 3 },
      ),
    ).toBe('b c\ne f');
    expect(
      pickLocator({ kind: 'text', page: null, start: 3, end: 9, text: 'x' }),
    ).toEqual({ kind: 'text', page: null, start: 3, end: 9 });
    expect(onPage({ kind: 'text', page: null, start: 0, end: 1 }, 1, 1)).toBe(
      true,
    );
    expect(onPage({ kind: 'text', page: null, start: 0, end: 1 }, 1, 2)).toBe(
      false,
    );
    expect(onPage({ kind: 'text', page: 2, start: 0, end: 1 }, 2, 3)).toBe(
      true,
    );
  });

  it('splits source text at overlapping spans', () => {
    expect(
      textSegments('abcdef', [
        { id: 'x', start: 1, end: 4 },
        { id: 'y', start: 3, end: 10 },
      ]),
    ).toEqual([
      { start: 0, end: 1, text: 'a', spans: [] },
      { start: 1, end: 3, text: 'bc', spans: ['x'] },
      { start: 3, end: 4, text: 'd', spans: ['x', 'y'] },
      { start: 4, end: 6, text: 'ef', spans: ['y'] },
    ]);
  });
});
