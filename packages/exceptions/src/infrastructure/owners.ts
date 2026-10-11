import { randomUUID } from 'node:crypto';

import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type {
  CaseOwner,
  CaseOwnerAudit,
  CaseOwnerStore,
} from '../application/owners.js';

/** Changes owner under the case lock and appends a timeline-visible audit event in the same transaction. */
export function createCaseOwnerStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => {
    append(entry: CaseOwnerAudit): Promise<void>;
  },
): CaseOwnerStore {
  return {
    assign: (context, id, input) =>
      db.transaction(context.tenantId, async (tx) => {
        const incident = (
          await tx.query(
            'SELECT id FROM exceptions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [context.tenantId, id],
          )
        ).rows[0];
        if (!incident)
          throw new IdentityError(404, 'NOT_FOUND', 'Case not found.');
        const current = (
          await tx.query<{ document: CaseOwner }>(
            'SELECT document FROM case_owners WHERE tenant_id=$1 AND exception_id=$2',
            [context.tenantId, id],
          )
        ).rows[0]?.document;
        if ((current?.revision ?? 0) !== input.revision) {
          if (
            current?.revision === input.revision + 1 &&
            current.userId === input.userId &&
            current.assignedBy === context.actor.id
          )
            return current;
          throw new IdentityError(
            409,
            'CONFLICT',
            'The case owner changed. Refresh the case.',
          );
        }
        const person = input.userId
          ? (
              await tx.query<{ name: string }>(
                'SELECT name FROM workspace_people WHERE tenant_id=$1 AND user_id=$2 AND is_member',
                [context.tenantId, input.userId],
              )
            ).rows[0]
          : null;
        if (input.userId && !person)
          throw new IdentityError(
            422,
            'VALIDATION_ERROR',
            'Choose a current workspace member.',
          );
        const owner: CaseOwner = {
          userId: input.userId,
          name: person?.name ?? null,
          revision: input.revision + 1,
          assignedBy: context.actor.id,
          assignedAt: new Date().toISOString(),
        };
        await tx.query(
          'INSERT INTO case_owners(tenant_id,exception_id,user_id,document) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,exception_id) DO UPDATE SET user_id=EXCLUDED.user_id,document=EXCLUDED.document',
          [context.tenantId, id, input.userId, owner],
        );
        const auditId = randomUUID();
        await audit({
          transaction: async (_tenant, operation) => operation(tx),
        }).append({
          id: auditId,
          tenantId: context.tenantId,
          eventKey: `case-owner:${id}:${owner.revision}`,
          eventType: 'case.owner_changed',
          schemaVersion: 1,
          occurredAt: owner.assignedAt,
          actor: { kind: 'user', id: context.actor.id },
          correlationId: context.requestId,
          proposalId: id,
          actionHash: '',
          evidenceRefs: [],
          details: {
            previousOwner: current?.userId ?? '',
            owner: input.userId ?? '',
            ownerName: person?.name ?? '',
          },
        });

        return owner;
      }),
  };
}
