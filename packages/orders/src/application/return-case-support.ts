import type { AuditEntry } from '@luma/audit';
import {
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import { canonicalJson, forbidden } from '@luma/platform';
import type { ProposedAction } from '@luma/policies';

import type { DecisionEvidence, ReturnCase } from '../domain/return-cases.js';
import type { ReturnCreation } from '../domain/return-creations.js';
import type {
  ReturnCaseDependencies,
  ReturnCaseEvent,
  ReturnCaseEventKind,
  ReturnCaseTransaction,
} from './return-cases.js';

const auditSummaries: Record<ReturnCaseEventKind, string> = {
  opened: 'Return case opened',
  assigned: 'Return case assigned',
  receipt_recorded: 'Return receipt recorded',
  inspection_recorded: 'Return inspection recorded',
  resolution_proposed: 'Return resolution proposed',
  cancelled: 'Return case cancelled',
  creation_requested: 'Approval requested to create the return',
  creation_approved: 'Creating the return approved',
  creation_rejected: 'Creating the return rejected',
  creation_created: 'Return created and verified',
  exchange_completed: 'Exchange independently verified across both systems',
  exchange_reopened: 'Exchange reopened after an unresolved source check',
};

/** The exact action a creation asks admission to perform. */
export function creationAction(creation: ReturnCreation): ProposedAction {
  return {
    schemaVersion: 1,
    id: creation.actionId,
    tenantId: creation.tenantId,
    capability: 'returns.create',
    capabilityVersion: '0',
    connectionId: creation.connectionId,
    target: { kind: 'return_case_creation', id: creation.id },
    parameters: {
      returnCaseId: creation.caseId,
      orderId: creation.order.externalId,
      orderScope: creation.order.scopeKey,
      ...(creation.requestedReturn
        ? {
            requestedReturnId: creation.requestedReturn.externalId,
            requestedReturnScope: creation.requestedReturn.scopeKey,
          }
        : {}),
      warehouseId: creation.warehouse.externalId,
      warehouseScope: creation.warehouse.scopeKey,
      reasonId: creation.reason.externalId,
      reasonScope: creation.reason.scopeKey,
      // Canonical key order: stored creations come back from jsonb with reordered keys.
      lines: canonicalJson(
        creation.lines.map((line) => ({
          orderLineId: line.orderLineId,
          source: line.source,
          quantity: line.quantity,
        })),
      ),
    },
    preconditions: {
      evidenceRefs: [creation.caseId, creation.id],
      validUntil: creation.expiresAt,
    },
    expectedPostcondition: {
      lumaCaseId: creation.caseId,
      lines: creation.lines.length,
    },
    risk: 'high',
    proposedBy: { kind: 'user', id: creation.requestedBy },
    expiresAt: creation.expiresAt,
  };
}

/**
 * Helpers every return case command group shares: fresh authorization, history entries,
 * their audit records and creation saves.
 */
export function createReturnCaseSupport(deps: ReturnCaseDependencies) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, write ? 'returns.manage' : 'returns.read');
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');

    return fresh;
  }

  function audit(
    context: TenantContext,
    event: ReturnCaseEvent,
    value: ReturnCase,
    evidenceRefs: string[] = [],
  ): AuditEntry {
    const details: Record<string, string> = {
      reason: auditSummaries[event.kind],
      returnCaseId: value.id,
      orderId: value.orderId,
      revision: String(event.revision),
    };
    if (event.details.resolution) details.resolution = event.details.resolution;
    if (event.details.creationId) details.creationId = event.details.creationId;
    if (event.details.externalNumber)
      details.externalNumber = event.details.externalNumber;

    return {
      id: deps.uuid(
        `audit:${context.tenantId}:return_case.${event.kind}:${event.id}`,
      ),
      tenantId: context.tenantId,
      eventKey: `orders:return_case.${event.kind}:${event.id}`,
      eventType: `return_case.${event.kind}`,
      schemaVersion: 1,
      occurredAt: event.occurredAt,
      actor: { kind: 'user', id: event.actorId },
      correlationId: value.id,
      proposalId: value.id,
      actionHash: deps.digest({ kind: event.kind, id: event.id, details }),
      evidenceRefs: [value.id, ...evidenceRefs],
      details,
    };
  }

  function event(
    context: TenantContext,
    value: ReturnCase,
    commandId: string,
    digest: string,
    kind: ReturnCaseEventKind,
    evidence: DecisionEvidence | null,
    details: ReturnCaseEvent['details'],
    actorId = context.actor.id,
  ): ReturnCaseEvent {
    return {
      id: deps.uuid(`return-case-event:${context.tenantId}:${commandId}`),
      tenantId: context.tenantId,
      caseId: value.id,
      commandId,
      digest,
      kind,
      actorId,
      revision: value.revision,
      occurredAt: deps.now().toISOString(),
      evidence,
      details,
    };
  }

  async function saveCreation(
    tx: ReturnCaseTransaction,
    creation: ReturnCreation,
    patch: Partial<ReturnCreation>,
  ) {
    const next = {
      ...creation,
      ...patch,
      updatedAt: deps.now().toISOString(),
    };
    await tx.saveCreation(next);

    return next;
  }

  /** Records a creation event at the case's current revision without changing the case. */
  async function creationEvent(
    context: TenantContext,
    tx: ReturnCaseTransaction,
    creation: ReturnCreation,
    kind: ReturnCaseEventKind,
    details: ReturnCaseEvent['details'] = {},
    evidenceRefs: string[] = [],
    actorId = context.actor.id,
  ) {
    const value = (await tx.case(creation.caseId))!;
    const commandId = deps.uuid(
      `return-creation:${context.tenantId}:${kind}:${creation.id}`,
    );
    if (await tx.event(commandId)) return;
    const entry = event(
      context,
      value,
      commandId,
      commandId,
      kind,
      null,
      { creationId: creation.id, ...details },
      actorId,
    );
    await tx.insertEvent(entry);
    await tx.audit(audit(context, entry, value, evidenceRefs));
  }

  return { authorize, audit, event, saveCreation, creationEvent };
}

export type ReturnCaseSupport = ReturnType<typeof createReturnCaseSupport>;
