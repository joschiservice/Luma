import { describe, expect, it } from 'vitest';

import { selectRange } from './row-selection';

const keys = ['a', 'b', 'c', 'd', 'e'];

describe('selectRange', () => {
  it('selects every row between the anchor and the row, in either direction', () => {
    expect(selectRange(keys, [], 1, 3, true)).toEqual(['b', 'c', 'd']);
    expect(selectRange(keys, [], 3, 1, true)).toEqual(['b', 'c', 'd']);
  });

  it('keeps selected rows outside the range, including rows on other pages', () => {
    expect(selectRange(keys, ['a', 'z'], 2, 3, true)).toEqual([
      'a',
      'z',
      'c',
      'd',
    ]);
  });

  it('clears the range when the clicked row is being deselected', () => {
    expect(selectRange(keys, ['a', 'b', 'c', 'd'], 1, 2, false)).toEqual([
      'a',
      'd',
    ]);
  });

  it('stays within the page when the anchor has scrolled out of range', () => {
    expect(selectRange(keys, [], 9, 3, true)).toEqual(['d', 'e']);
  });
});
