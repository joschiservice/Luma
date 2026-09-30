import { createHash } from 'node:crypto';

import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { ReturnWorkspace } from '../../application/returns.js';
import { readReturnDetail } from './detail.js';
import { readReturns, readReturnSources, type ReturnPosition } from './list.js';

const cursorSchema = z
  .object({
    context: z.string(),
    key: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

const encode = (context: string, position: ReturnPosition) =>
  Buffer.from(JSON.stringify({ context, ...position })).toString('base64url');

/** Creates tenant-scoped reads of returns and refunds in a consistent database snapshot. */
export function createReturnWorkspace(db: TenantDatabase): ReturnWorkspace {
  return {
    async list(context, query) {
      requireTenant(context, context.tenantId);
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            'returns-v1',
            context.tenantId,
            query.q,
            query.view,
            query.stage ?? null,
            query.connectionId ?? null,
            query.sort,
            query.direction,
          ]),
        )
        .digest('hex');
      let after: ReturnPosition | null = null;
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
              'This page link no longer matches the return filters. Start from the first page.',
            ),
            { statusCode: 400, expose: true },
          );
        }
      }

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const { rows, counts } = await readReturns(
            tx,
            context.tenantId,
            query,
            after,
          );
          const page = rows.slice(0, query.limit);
          const last = page.at(-1);

          return {
            items: page.map((row) => row.item),
            sources: await readReturnSources(tx, context.tenantId),
            counts,
            nextCursor:
              rows.length > query.limit && last
                ? encode(scope, { key: last.position, id: last.item.id })
                : null,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
    async get(context, id) {
      requireTenant(context, context.tenantId);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const detail = await readReturnDetail(tx, context.tenantId, id);

          return detail ? { ...detail, asOf: new Date().toISOString() } : null;
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
