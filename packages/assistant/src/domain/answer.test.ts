import { describe, expect, it } from 'vitest';

import {
  boundResult,
  citationMarker,
  type RecordReference,
  resolveCitations,
} from './answer.js';

const order = (id: string): RecordReference => ({
  kind: 'order',
  id,
  label: `Order ${id.slice(0, 4)}`,
  detail: null,
  sources: [{ label: 'Shop', system: 'shopify' }],
  observedAt: '2026-10-05T10:00:00.000Z',
  sourceUpdatedAt: null,
});

const read = '11111111-1111-4111-8111-111111111111';
const unread = '22222222-2222-4222-8222-222222222222';

describe('resolveCitations', () => {
  it('keeps markers for records read for this question, in order of first mention', () => {
    const issue: RecordReference = {
      ...order(unread),
      kind: 'issue',
      label: 'Fulfillment delay',
    };
    const result = resolveCitations(
      `Order [[issue:${unread.toUpperCase()}]] and [[order:${read}]], again [[order:${read}]].`,
      new Map([
        [citationMarker('order', read), order(read)],
        [citationMarker('issue', unread), issue],
      ]),
    );

    expect(result.content).toBe(
      `Order [[issue:${unread}]] and [[order:${read}]], again [[order:${read}]].`,
    );
    expect(result.citations.map((item) => item.id)).toEqual([unread, read]);
  });

  it('removes markers for records the answer did not read', () => {
    const result = resolveCitations(
      `Late: [[order:${read}]] and [[order:${unread}]].`,
      new Map([[citationMarker('order', read), order(read)]]),
    );

    expect(result.content).toBe(`Late: [[order:${read}]] and.`);
    expect(result.citations).toHaveLength(1);
  });
});

describe('boundResult', () => {
  it('drops items from the end until the result fits and reports how many', () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      cite: `[[order:${index}]]`,
      note: 'x'.repeat(100),
    }));
    const text = boundResult({ items, nextCursor: 'next' }, 2_000);
    const parsed = JSON.parse(text);

    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.length + parsed.omitted).toBe(40);
    expect(parsed.nextCursor).toBe('next');
  });

  it('clips long provider text and replaces results that cannot fit', () => {
    const clipped = JSON.parse(boundResult({ note: 'y'.repeat(2_000) }, 4_000));
    expect(clipped.note).toHaveLength(500);

    expect(JSON.parse(boundResult({ a: 'z'.repeat(400) }, 100))).toMatchObject({
      error: 'result_too_large',
    });
  });
});
