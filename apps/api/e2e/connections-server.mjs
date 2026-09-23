import { randomBytes } from 'node:crypto';

import { buildRuntimeApp } from '@luma/application-runtime';
import { readIdentityConfig } from '@luma/config';
import { createInstalledConnections } from '@luma/connections/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';

// A deterministic provider boundary; HTTP, authentication, encryption and persistence are real.
const pool = new Pool({ connectionString: process.env.IDENTITY_DATABASE_URL });

const app = await buildRuntimeApp(
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
