import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { conflict } from '@luma/platform';

/** Escalation retains the incident and its evidence; it never claims resolution. */
export function createEscalationRepository(db: TenantDatabase) {
  return (context: TenantContext, id: string, revision: number) =>
    db.transaction(context.tenantId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `exceptions:${context.tenantId}`,
      ]);
      const result = await tx.query<{ version: number }>(
        `UPDATE exceptions SET state='escalated',document=jsonb_set(document,'{state}','"escalated"'),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$3 AND state NOT IN ('resolved','escalated') RETURNING version`,
        [context.tenantId, id, revision],
      );
      if (!result.rows[0])
        throw conflict('The case changed. Refresh before escalating.');
      await tx.query(
        'INSERT INTO exception_outbox(id,tenant_id,exception_id,document) VALUES($1,$2,$3,$4)',
        [
          randomUUID(),
          context.tenantId,
          id,
          {
            type: 'exception.escalated',
            at: new Date().toISOString(),
            actorId: context.actor.id,
          },
        ],
      );

      return result.rows[0].version;
    });
}
