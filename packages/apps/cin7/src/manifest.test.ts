import { createAppRegistry } from '@luma/app-host';
import { expect, it } from 'vitest';

import { createApp } from './index.js';

it('declares a valid read-only manifest', () => {
  const app = createApp();
  expect(() => createAppRegistry([app])).not.toThrow();
  expect(app.manifest.permissions).toEqual([]);
  expect(app.manifest.scopes).not.toContain('actions.execute');
});
