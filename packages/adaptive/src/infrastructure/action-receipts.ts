import type { TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';
import { z } from 'zod';

import type { createViewActions } from '../application/actions.js';

const results = z.array(
  z.object({
    recordId: z.string().uuid(),
    state: z.enum([
      'proposed',
      'approval_required',
      'verified',
      'uncertain',
      'failed',
      'unavailable',
    ]),
    reason: z.string().nullable(),
    proposalId: z.string().nullable(),
    destination: z.string().nullable(),
  }),
);

/** Claims before owner dispatch; retained uncertain receipts prevent duplicate commands after a crash. */
export function createActionReceipts(
  db: TenantDatabase,
): NonNullable<Parameters<typeof createViewActions>[0]['receipts']> {
  return {
    get: (c, id, digest) =>
      db.transaction(c.tenantId, async (tx) => {
        const row = (
          await tx.query<{ digest: string; results: unknown }>(
            'SELECT digest,results FROM adaptive_action_receipts WHERE tenant_id=$1 AND command_id=$2',
            [c.tenantId, id],
          )
        ).rows[0];
        if (!row) return null;
        if (row.digest !== digest)
          throw conflict('This command ID was used for another action.');

        return results.parse(row.results);
      }),
    claim: (c, id, digest, initial) =>
      db.transaction(c.tenantId, async (tx) => {
        const created = await tx.query(
          'INSERT INTO adaptive_action_receipts(tenant_id,command_id,digest,results) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING command_id',
          [c.tenantId, id, digest, JSON.stringify(initial)],
        );
        if (created.rowCount) return null;
        const row = (
          await tx.query<{ digest: string; results: unknown }>(
            'SELECT digest,results FROM adaptive_action_receipts WHERE tenant_id=$1 AND command_id=$2',
            [c.tenantId, id],
          )
        ).rows[0];
        if (!row || row.digest !== digest)
          throw conflict('This command ID was used for another action.');

        return results.parse(row.results);
      }),
    save: async (c, id, digest, value) => {
      results.parse(value);
      await db.transaction(c.tenantId, (tx) =>
        tx.query(
          'UPDATE adaptive_action_receipts SET results=$4::jsonb WHERE tenant_id=$1 AND command_id=$2 AND digest=$3',
          [c.tenantId, id, digest, JSON.stringify(value)],
        ),
      );
    },
  };
}
