import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { conflict, invalid, notFound } from '@luma/platform';

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
  /** Locks the case and returns its current owner; throws 404 for an unknown case. */
  async function current(
    tx: SqlTransaction,
    context: TenantContext,
    id: string,
  ) {
    const incident = (
      await tx.query(
        'SELECT id FROM exceptions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [context.tenantId, id],
      )
    ).rows[0];
    if (!incident) throw notFound('Case not found.');

    return (
      await tx.query<{ document: CaseOwner }>(
        'SELECT document FROM case_owners WHERE tenant_id=$1 AND exception_id=$2',
        [context.tenantId, id],
      )
    ).rows[0]?.document;
  }

  async function change(
    tx: SqlTransaction,
    context: TenantContext,
    id: string,
    previous: CaseOwner | undefined,
    input: { userId: string | null; revision: number },
  ) {
    const person = input.userId
      ? (
          await tx.query<{ name: string }>(
            'SELECT name FROM workspace_people WHERE tenant_id=$1 AND user_id=$2 AND is_member',
            [context.tenantId, input.userId],
          )
        ).rows[0]
      : null;
    if (input.userId && !person)
      throw invalid('Choose a current workspace member.');
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
        previousOwner: previous?.userId ?? '',
        owner: input.userId ?? '',
        ownerName: person?.name ?? '',
      },
    });

    return owner;
  }

  return {
    assign: (context, id, input) =>
      db.transaction(context.tenantId, async (tx) => {
        const previous = await current(tx, context, id);
        if ((previous?.revision ?? 0) !== input.revision) {
          if (
            previous?.revision === input.revision + 1 &&
            previous.userId === input.userId &&
            previous.assignedBy === context.actor.id
          )
            return previous;
          throw conflict('The case owner changed. Refresh the case.');
        }

        return change(tx, context, id, previous, input);
      }),
    claim: (context, id, userId) =>
      db.transaction(context.tenantId, async (tx) => {
        const previous = await current(tx, context, id);
        if (previous?.userId) return previous;

        return change(tx, context, id, previous, {
          userId,
          revision: previous?.revision ?? 0,
        });
      }),
  };
}
