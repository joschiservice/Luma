import { createHash } from 'node:crypto';

import { requirePermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { CustomerWorkspace } from '../../application/customers.js';
import {
  type CustomerPosition,
  readCustomer,
  readCustomers,
  readCustomerSources,
} from './list.js';

const cursorSchema = z
  .object({
    context: z.string(),
    key: z.string().max(1024),
    id: z.string().uuid(),
  })
  .strict();

const encode = (context: string, position: CustomerPosition) =>
  Buffer.from(JSON.stringify({ context, ...position })).toString('base64url');

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400, expose: true });

/** Creates tenant-scoped reads of imported customer profiles in a consistent database snapshot. */
export function createCustomerWorkspace(db: TenantDatabase): CustomerWorkspace {
  return {
    async list(context, query) {
      requirePermission(context, 'customers.read');
      if (query.externalId && !query.connectionId)
        throw badRequest('Choose the source of this customer ID.');
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            'customers-v1',
            context.tenantId,
            query.q,
            query.state ?? null,
            query.connectionId ?? null,
            query.externalId ?? null,
            query.sort,
            query.direction,
          ]),
        )
        .digest('hex');
      let after: CustomerPosition | null = null;
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
          throw badRequest(
            'This page link no longer matches the customer filters. Start from the first page.',
          );
        }
      }

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const { rows, totalCount } = await readCustomers(
            tx,
            context.tenantId,
            query,
            after,
          );
          const page = rows.slice(0, query.limit);
          const last = page.at(-1);

          return {
            items: page.map((row) => row.item),
            sources: await readCustomerSources(tx, context.tenantId),
            totalCount,
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
      requirePermission(context, 'customers.read');

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const profile = await readCustomer(tx, context.tenantId, id);
          if (!profile) return null;
          const [source] = await readCustomerSources(
            tx,
            context.tenantId,
            profile.item.connectionId,
          );

          return {
            ...profile,
            source: source ?? null,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
