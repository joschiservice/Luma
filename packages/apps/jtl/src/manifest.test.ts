import type { AppFactoryContext } from '@luma/app-host';
import { createAppRegistry } from '@luma/app-host';
import { expect, it } from 'vitest';

import { jtlPermissions } from './domain/permissions.js';
import { createApp } from './index.js';

it('declares each write capability permission in a valid manifest', () => {
  const app = createApp({ env: {} } as AppFactoryContext);
  expect(() => createAppRegistry([app])).not.toThrow();
  expect(app.manifest.permissions.map((permission) => permission.key)).toEqual(
    Object.values(jtlPermissions),
  );
});
