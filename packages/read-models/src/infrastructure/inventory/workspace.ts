import { createHash } from 'node:crypto';

import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { InventoryWorkspace } from '../../application/inventory.js';
import { readPositions } from './positions.js';
import { readStockContext } from './related.js';

const cursorSchema = z
  .object({ context: z.string(), id: z.string().uuid() })
  .strict();

/** Creates tenant-scoped inventory reads in a consistent database snapshot. */
export function createInventoryWorkspace(
  db: TenantDatabase,
): InventoryWorkspace {
  return {
    async list(context, query) {
      requireTenant(context, context.tenantId);
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            'inventory-v1',
            context.tenantId,
            query.q,
            query.view,
            query.skuId ?? null,
            query.locationId ?? null,
            query.connectionId ?? null,
          ]),
        )
        .digest('hex');
      let after: string | null = null;
      if (query.cursor) {
        try {
          const bytes = Buffer.from(query.cursor, 'base64url');
          if (bytes.toString('base64url') !== query.cursor)
            throw new Error('Encoding');
          const cursor = cursorSchema.parse(JSON.parse(bytes.toString()));
          if (cursor.context !== scope) throw new Error('Context');
          after = cursor.id;
        } catch {
          throw Object.assign(
            new Error(
              'This page link no longer matches the inventory filters. Start from the first page.',
            ),
            { statusCode: 400, expose: true },
          );
        }
      }

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const items = await readPositions(tx, context.tenantId, query, after);

          return {
            items: items.slice(0, 50),
            nextCursor:
              items.length > 50
                ? Buffer.from(
                    JSON.stringify({ context: scope, id: items[49]!.id }),
                  ).toString('base64url')
                : null,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
    async get(context, positionId) {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const [position] = await readPositions(
            tx,
            context.tenantId,
            { q: '', view: 'all' },
            null,
            positionId,
          );
          if (!position) return null;

          return {
            position,
            ...(await readStockContext(tx, context.tenantId, position)),
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
