import { randomBytes } from 'node:crypto';

import { readIdentityConfig } from '@luma/config';
import { Pool } from 'pg';

import { buildRuntimeApp } from '../dist/app.js';
import { createInstalledConnections } from '../dist/modules/connectors/composition.js';
import { createTenantDatabase } from '../dist/modules/platform/composition.js';

// A deterministic provider boundary; HTTP, authentication, encryption and persistence are real.
const pool = new Pool({ connectionString: process.env.IDENTITY_DATABASE_URL });

const app = buildRuntimeApp(
  readIdentityConfig(process.env),
  { logger: false },
  undefined,
  undefined,
  (identity) =>
    createInstalledConnections(createTenantDatabase(pool), {
      refreshContext: identity.refreshContext,
      activeKeyId: 'test',
      keys: new Map([['test', randomBytes(32)]]),
      verify: async (_connection, credentials) => {
        if (credentials.token !== 'valid-test-token')
          throw new Error('Invalid fixture credential');

        return [
          'orders.read',
          'products.read',
          'inventory.read',
          'fulfillment.read',
          'orders.shipping-method.read',
          'orders.shipping-method.write',
        ];
      },
    }),
);

app.addHook('onClose', () => pool.end());

const address = await app.listen({ host: '127.0.0.1', port: 0 });

process.send?.({ type: 'listening', address });
