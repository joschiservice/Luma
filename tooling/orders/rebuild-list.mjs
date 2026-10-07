import { randomUUID } from 'node:crypto';

import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createOrderListRebuilder } from '@luma/orders/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';

const [tenantId] = process.argv.slice(2);
if (
  !/^[0-9a-f-]{36}$/i.test(tenantId ?? '') ||
  !process.env.ORDERS_DATABASE_URL
)
  throw new Error(
    'Usage: ORDERS_DATABASE_URL=<Orders writer connection> node tooling/orders/rebuild-list.mjs <tenant UUID>',
  );
const pool = new Pool({
  connectionString: process.env.ORDERS_DATABASE_URL,
  max: 1,
});
// This operator command is authorized by the supplied Orders writer credential. It never
// resolves a browser session or grants database access beyond that restricted credential.
const context = makeTenantContext(
  { userId: 'orders-list-rebuild', sessionId: randomUUID() },
  {
    id: tenantId,
    name: 'Rebuild',
    slug: 'rebuild',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: 'operator', organizationId: tenantId, userId: 'orders-list-rebuild' },
    'owner',
  ),
  randomUUID(),
);
try {
  const rebuild = createOrderListRebuilder(createTenantDatabase(pool));
  let after;
  do {
    after = await rebuild(context, after ?? undefined);
    console.log(
      after ? `Rebuilt through ${after}` : 'Order list rebuild complete.',
    );
  } while (after);
} finally {
  await pool.end();
}
