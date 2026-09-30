import { createHash } from 'node:crypto';

import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { ProductWorkspace } from '../../application/products.js';
import {
  type CatalogPosition,
  readCatalog,
  readSku,
  readSources,
} from './catalog.js';
import { readProductContext } from './detail.js';

const cursorSchema = z
  .object({
    context: z.string(),
    rank: z.number().int().min(0).max(2),
    key: z.string().max(4096),
    skuId: z.string().uuid(),
  })
  .strict();

const encode = (context: string, position: CatalogPosition) =>
  Buffer.from(JSON.stringify({ context, ...position })).toString('base64url');

/** Creates tenant-scoped product catalog reads in a consistent database snapshot. */
export function createProductWorkspace(db: TenantDatabase): ProductWorkspace {
  return {
    async list(context, query) {
      requireTenant(context, context.tenantId);
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            'products-v1',
            context.tenantId,
            query.q,
            query.view,
            query.connectionId ?? null,
            query.missingFrom ?? null,
          ]),
        )
        .digest('hex');
      let after: CatalogPosition | null = null;
      if (query.cursor) {
        try {
          const bytes = Buffer.from(query.cursor, 'base64url');
          if (bytes.toString('base64url') !== query.cursor)
            throw new Error('Encoding');
          const { context: cursorContext, ...position } = cursorSchema.parse(
            JSON.parse(bytes.toString()),
          );
          if (cursorContext !== scope) throw new Error('Context');
          after = position;
        } catch {
          throw Object.assign(
            new Error(
              'This page link no longer matches the product filters. Start from the first page.',
            ),
            { statusCode: 400, expose: true },
          );
        }
      }

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const limit = query.limit ?? 50;
          // Comparing a whole catalog aggregates every listing; keep it in memory.
          await tx.query("SET LOCAL work_mem='32MB'");
          const catalog = await readCatalog(tx, context.tenantId, query, after);
          const last = catalog.items[limit - 1];

          return {
            items: catalog.items.slice(0, limit).map((entry) => entry.item),
            sources: await readSources(tx, context.tenantId),
            counts: catalog.counts,
            nextCursor:
              catalog.items.length > limit && last
                ? encode(scope, last.position)
                : null,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
    async get(context, skuId) {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const sku = await readSku(tx, context.tenantId, skuId);
          if (!sku) return null;
          const sources = await readSources(tx, context.tenantId);
          const catalog = await readCatalog(
            tx,
            context.tenantId,
            { q: '', view: 'all' },
            null,
            skuId,
          );
          // A SKU known only from stock or order lines has no listing in any catalog.
          const item = catalog.items[0]?.item ?? {
            skuId,
            sku: sku.sku,
            skuKey: sku.skuKey,
            title: null,
            listings: [],
            differences: [],
            gaps: sources.map((source) => ({
              connectionId: source.connectionId,
              match: null,
            })),
          };

          return {
            item,
            sources,
            ...(await readProductContext(tx, context.tenantId, item)),
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
