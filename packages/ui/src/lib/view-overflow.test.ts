import { describe, expect, it } from 'vitest';

import { fitViews } from './view-overflow';

const widths = [60, 80, 100, 70, 90];

describe('fitViews', () => {
  it('shows every view without More when all of them fit', () => {
    expect(fitViews({ widths, available: 400, more: 50 })).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('keeps room for More once any view overflows', () => {
    // 60 + 80 + 100 = 240 fits beside More in 300; adding 70 does not.
    expect(fitViews({ widths, available: 300, more: 50 })).toEqual([0, 1, 2]);
  });

  it('shows the current view in place of the last views that fit', () => {
    expect(fitViews({ widths, available: 300, more: 50, current: 4 })).toEqual([
      0, 1, 4,
    ]);
    expect(fitViews({ widths, available: 200, more: 50, current: 2 })).toEqual([
      2,
    ]);
  });

  it('keeps the current view when it is wider than the room', () => {
    expect(fitViews({ widths, available: 100, more: 50, current: 2 })).toEqual([
      2,
    ]);
  });

  it('ignores a current view that is not offered', () => {
    expect(fitViews({ widths, available: 300, more: 50, current: 9 })).toEqual([
      0, 1, 2,
    ]);
  });
});
