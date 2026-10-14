import { describe, expect, it } from 'vitest';

import {
  clampColumnWidth,
  moveColumn,
  pinColumn,
  setColumnShown,
  setColumnWidth,
  shownColumns,
} from './column-state';

const keys = ['number', 'status', 'total', 'placed'];
const all = { columns: [] };

describe('shownColumns', () => {
  it('shows every column in definition order when the state lists none', () => {
    expect(shownColumns(all, keys).map((column) => column.key)).toEqual(keys);
  });

  it('drops unknown and repeated keys and keeps required columns', () => {
    const state = {
      columns: [{ key: 'total' }, { key: 'archived' }, { key: 'total' }],
    };
    expect(
      shownColumns(state, keys, ['number']).map((column) => column.key),
    ).toEqual(['number', 'total']);
  });

  it('puts the pinned column first', () => {
    const state = {
      columns: [{ key: 'status' }, { key: 'total', width: 140 }],
      pinned: 'total',
    };
    expect(shownColumns(state, keys)).toEqual([
      { key: 'total', width: 140 },
      { key: 'status' },
    ]);
  });
});

describe('moveColumn', () => {
  it('moves a column within the shown columns', () => {
    expect(moveColumn(all, keys, 'total', -1).columns).toEqual([
      { key: 'number' },
      { key: 'total' },
      { key: 'status' },
      { key: 'placed' },
    ]);
  });

  it('does not move past either end', () => {
    expect(moveColumn(all, keys, 'number', -1)).toBe(all);
    expect(moveColumn(all, keys, 'placed', 1)).toBe(all);
  });

  it('keeps the pinned column first', () => {
    const pinned = pinColumn(all, keys, 'total');
    expect(moveColumn(pinned, keys, 'number', -1)).toBe(pinned);
    expect(moveColumn(pinned, keys, 'total', 1)).toBe(pinned);
  });
});

describe('setColumnShown', () => {
  it('hides a column and shows it again at the end', () => {
    const hidden = setColumnShown(all, keys, 'status', false);
    expect(hidden.columns.map((column) => column.key)).toEqual([
      'number',
      'total',
      'placed',
    ]);
    expect(
      setColumnShown(hidden, keys, 'status', true).columns.map(
        (column) => column.key,
      ),
    ).toEqual(['number', 'total', 'placed', 'status']);
  });

  it('never hides a required column or the last column', () => {
    expect(setColumnShown(all, keys, 'number', false, ['number'])).toBe(all);
    const one = { columns: [{ key: 'total' }] };
    expect(setColumnShown(one, keys, 'total', false)).toBe(one);
  });

  it('unpins a column when it is hidden', () => {
    const pinned = pinColumn(all, keys, 'status');
    expect(
      setColumnShown(pinned, keys, 'status', false).pinned,
    ).toBeUndefined();
  });
});

describe('setColumnWidth', () => {
  it('clamps widths to the saved view limits and resets with undefined', () => {
    const wide = setColumnWidth(all, keys, 'total', 2000);
    expect(wide.columns.find((column) => column.key === 'total')).toEqual({
      key: 'total',
      width: 960,
    });
    expect(
      setColumnWidth(wide, keys, 'total', undefined).columns.find(
        (column) => column.key === 'total',
      ),
    ).toEqual({ key: 'total' });
    expect(clampColumnWidth(10.4)).toBe(48);
    expect(clampColumnWidth(150.6)).toBe(151);
  });
});

describe('pinColumn', () => {
  it('pins a shown column first and unpins it', () => {
    const pinned = pinColumn(all, keys, 'placed');
    expect(pinned.pinned).toBe('placed');
    expect(pinned.columns[0]).toEqual({ key: 'placed' });
    expect(pinColumn(pinned, keys, undefined).pinned).toBeUndefined();
  });

  it('ignores a hidden column', () => {
    const state = { columns: [{ key: 'number' }] };
    expect(pinColumn(state, keys, 'total').pinned).toBeUndefined();
  });
});
