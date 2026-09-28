import { describe, expect, it } from 'vitest';

import { defaultHome, moveModule, placeModule } from './preferences';

describe('Home module ordering', () => {
  it('moves a module one place and keeps edges unchanged', () => {
    expect(moveModule(defaultHome, 'handling', -1).map((m) => m.id)).toEqual([
      'handling',
      'attention',
      'connections',
      'activity',
    ]);
    expect(moveModule(defaultHome, 'attention', -1)).toBe(defaultHome);
    expect(moveModule(defaultHome, 'activity', 1)).toBe(defaultHome);
  });

  it('places a dragged module before its drop target', () => {
    expect(
      placeModule(defaultHome, 'activity', 'handling').map((m) => m.id),
    ).toEqual(['attention', 'activity', 'handling', 'connections']);
    expect(placeModule(defaultHome, 'outcomes', 'handling')).toBe(defaultHome);
  });
});
