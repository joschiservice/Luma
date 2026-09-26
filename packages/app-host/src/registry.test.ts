import { describe, expect, it } from 'vitest';

import { type AppDefinition, createAppRegistry } from './index.js';

const app: AppDefinition = {
  manifest: {
    id: 'notes',
    name: 'Notes',
    description: 'Workspace notes',
    version: '1.0.0',
    category: 'utility',
    ui: ['page'],
    connectionTypes: [],
  },
};
describe('app registry', () => {
  it('boots with zero apps and accepts apps with UI and no connector', async () => {
    const empty = createAppRegistry();
    expect(empty.list()).toEqual([]);
    expect(empty.provider('removed')).toBeUndefined();
    expect(await empty.ready()).toBe(true);
    expect(createAppRegistry([app]).list()).toEqual([app.manifest]);
  });
  it('rejects duplicate app IDs and keeps catalog mutations isolated', () => {
    expect(() => createAppRegistry([app, app])).toThrow('duplicate');
    const registry = createAppRegistry([app]);
    registry.list()[0]!.ui.length = 0;
    expect(registry.list()[0]!.ui).toEqual(['page']);
  });
});
