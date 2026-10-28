import {
  hasPermission,
  isAppPermission,
  type TenantContext,
} from '@luma/identity';
import { notFound } from '@luma/platform';

import { type ReturnCase, returnCaseStage } from '../domain/return-cases.js';
import {
  liveCreationStates,
  type ReturnCreation,
} from '../domain/return-creations.js';
import type {
  CreationBlocker,
  CreationDecision,
  CreationView,
  Person,
  PersonView,
  ReturnCaseDependencies,
  ReturnCaseDetail,
  ReturnCaseSummary,
  ReturnConnection,
  SourceReturnRecord,
} from './return-cases.js';

const units = (value: ReturnCase) =>
  value.lines.reduce((sum, line) => sum + line.quantity, 0);

/**
 * Builds case summaries, case details and creation views from persisted state, with the
 * admission reads a creation view needs.
 */
export function createReturnCaseViews(deps: ReturnCaseDependencies) {
  /**
   * Admission reads for creation views within one service call. `decisions` holds decisions
   * already read in a batch; write modes are read once per connection.
   */
  function admissionReads(
    context: TenantContext,
    decisions?: Map<string, CreationDecision | null>,
  ) {
    const modes = new Map<
      string,
      Promise<'observe_only' | 'writes_enabled' | undefined>
    >();

    return {
      async decision(id: string) {
        if (!deps.admission) return null;
        if (decisions?.has(id)) return decisions.get(id) ?? null;

        return deps.admission.decision(context, id);
      },
      writeMode(connectionId: string) {
        let mode = modes.get(connectionId);
        if (!mode) {
          mode = Promise.resolve(
            deps.admission?.writeMode?.(context, connectionId),
          );
          modes.set(connectionId, mode);
        }

        return mode;
      },
    };
  }

  async function creationView(
    context: TenantContext,
    creation: ReturnCreation,
    people: Map<string, Person>,
    reads = admissionReads(context),
  ): Promise<CreationView> {
    const decision = creation.decisionId
      ? await reads.decision(creation.decisionId)
      : null;
    // An unsent approval ends with its window; the background pass records it soon after.
    const expired =
      ['approval_required', 'approved'].includes(creation.state) &&
      Date.parse(creation.expiresAt) <= deps.now().getTime();
    const observeOnly =
      creation.state === 'not_executed' ||
      (['approval_required', 'approved'].includes(creation.state) &&
        (await reads.writeMode(creation.connectionId)) === 'observe_only');
    const requester = context.actor.id === creation.requestedBy;
    const manager = hasPermission(context, 'returns.manage');
    // Approvers also need permission to approve changes and any app permission the creating
    // capability declares, as policy checks when they respond.
    const approver =
      manager &&
      hasPermission(context, 'decisions.respond') &&
      (!decision?.permission ||
        !isAppPermission(decision.permission) ||
        hasPermission(context, decision.permission));
    const person = (id: string) => ({
      id,
      name: people.get(id)?.name ?? null,
    });

    return {
      operation: creation.requestedReturn ? 'approve' : 'create',
      id: creation.id,
      state: expired ? 'expired' : creation.state,
      connectionId: creation.connectionId,
      warehouse: { name: creation.warehouse.name },
      reason: { name: creation.reason.name },
      lines: creation.lines.map((l) => ({
        orderLineId: l.orderLineId,
        quantity: l.quantity,
      })),
      requestedBy: person(creation.requestedBy),
      requestedAt: creation.requestedAt,
      expiresAt: creation.expiresAt,
      decidedBy: creation.decidedBy ? person(creation.decidedBy) : null,
      decidedAt: creation.decidedAt,
      decisionId: creation.decisionId,
      approvalOutcome: decision?.approval?.outcome ?? null,
      externalReturn: creation.externalReturn,
      createdAt: creation.createdAt,
      failure: creation.failure,
      observeOnly,
      canApprove:
        !observeOnly &&
        !expired &&
        approver &&
        !requester &&
        creation.state === 'approval_required' &&
        !decision?.approval,
      canSend:
        !observeOnly && !expired && requester && creation.state === 'approved',
      canCheck: manager && ['uncertain', 'sending'].includes(creation.state),
    };
  }

  function summary(
    value: ReturnCase,
    creations: ReturnCreation[],
    people: Map<string, Person>,
  ): ReturnCaseSummary {
    const created = creations.find((c) => c.state === 'created');

    return {
      id: value.id,
      orderId: value.orderId,
      connectionId: value.connectionId,
      sourceReturnId: value.sourceReturnId,
      state: value.state,
      stage: returnCaseStage(value),
      units: units(value),
      assignee: value.assigneeId
        ? {
            id: value.assigneeId,
            name: people.get(value.assigneeId)?.name ?? null,
          }
        : null,
      resolution: value.proposal?.kind ?? null,
      externalNumber: created?.externalReturn?.number ?? null,
      openedAt: value.openedAt,
      updatedAt: value.updatedAt,
    };
  }

  /** Explains whether this case's return can be created in its order's system now. */
  function availability(
    connection: ReturnConnection | null,
    value: ReturnCase,
    creation: ReturnCreation | null,
    mapped: boolean,
    sourceReturn: SourceReturnRecord | null,
  ): ReturnCaseDetail['creationAvailability'] {
    const result = (blocker: CreationBlocker | null) => ({
      blocker,
      connection: connection?.offersCreation
        ? { id: connection.id, label: connection.label }
        : null,
    });
    if (value.state === 'completed') return result('completed');
    if (value.state === 'cancelled') return result('cancelled');
    if (!connection?.offersCreation) return result('unsupported');
    if (!deps.admission) return result('execution_disabled');
    if (
      creation?.state === 'created' ||
      (connection.provider === 'shopify' &&
        sourceReturn &&
        sourceReturn.status !== 'requested')
    )
      return result('created');
    if (
      creation &&
      liveCreationStates.includes(creation.state) &&
      !(
        creation.state === 'approval_required' &&
        Date.parse(creation.expiresAt) <= deps.now().getTime()
      )
    )
      return result('in_progress');
    if (connection.status !== 'active') return result('connection_inactive');
    if (!connection.canCreate) return result('reconnect');
    if (!mapped) return result('unmapped');

    return result(null);
  }

  async function detail(
    context: TenantContext,
    caseId: string,
  ): Promise<ReturnCaseDetail> {
    const data = await deps.store.transaction(
      context.tenantId,
      false,
      async (tx) => {
        const value = await tx.case(caseId);
        if (!value) return null;
        // One transaction runs one query at a time.
        const sources = await tx.orderSources(value.orderId);
        const events = await tx.events(caseId);
        const creations = await tx.creations(caseId);
        const sourceReturn = value.sourceReturnId
          ? await tx.sourceReturn(value.sourceReturnId)
          : null;
        const ids = await tx.sourceIds(
          value.connectionId,
          value.orderId,
          value.lines.map((l) => l.orderLineId),
        );
        const people = await tx.people([
          value.openedBy,
          ...(value.assigneeId ? [value.assigneeId] : []),
          ...(value.cancellation ? [value.cancellation.by] : []),
          ...[value.receipt, value.inspection, value.proposal].flatMap((d) =>
            d ? [d.by] : [],
          ),
          ...events.flatMap((e) => [
            e.actorId,
            ...(e.details.assigneeId ? [e.details.assigneeId] : []),
          ]),
          ...creations.flatMap((c) => [
            c.requestedBy,
            ...(c.decidedBy ? [c.decidedBy] : []),
          ]),
        ]);

        return {
          value,
          source:
            sources.find((s) => s.connectionId === value.connectionId) ?? null,
          events,
          creations,
          sourceReturn,
          mapped:
            !!ids.order &&
            value.lines.every((l) => ids.lines.has(l.orderLineId)),
          people,
        };
      },
    );
    if (!data) throw notFound('Return case not found');
    const { value, people } = data;
    const person = (id: string): PersonView => ({
      id,
      name: people.get(id)?.name ?? null,
    });
    const latest = data.creations[0] ?? null;
    const received = new Map(
      value.receipt?.lines.map((l) => [l.orderLineId, l.received]) ?? [],
    );
    const inspected = new Map(
      value.inspection?.lines.map((l) => [l.orderLineId, l]) ?? [],
    );
    const restock = new Map(
      value.proposal?.lines.map((l) => [l.orderLineId, l.restock]) ?? [],
    );
    // An unreadable connection list leaves the case readable; creation then reads unsupported.
    const connections = deps.system
      ? await deps.system.connections(context).catch(() => [])
      : [];
    const connection =
      connections.find((c) => c.id === value.connectionId) ?? null;

    return {
      case: {
        ...summary(value, data.creations, people),
        revision: value.revision,
        openedBy: person(value.openedBy),
        cancellation: value.cancellation
          ? {
              by: person(value.cancellation.by),
              at: value.cancellation.at,
              reason: value.cancellation.reason,
            }
          : null,
      },
      order: {
        id: value.orderId,
        number: data.source?.displayNumber ?? null,
        connection: {
          id: value.connectionId,
          label: connection?.label ?? null,
          provider: connection?.provider ?? null,
        },
      },
      sourceReturn: data.sourceReturn
        ? {
            id: data.sourceReturn.entityId,
            name: data.sourceReturn.name,
            status: data.sourceReturn.status,
          }
        : null,
      lines: value.lines.map((line) => {
        const got = received.get(line.orderLineId);
        const judged = inspected.get(line.orderLineId);

        return {
          orderLineId: line.orderLineId,
          title: line.title,
          sku: line.sku,
          quantity: line.quantity,
          reason: line.reason,
          note: line.note,
          received: got ?? null,
          missing: got === undefined ? null : line.quantity - got,
          resellable: judged?.resellable ?? null,
          damaged: judged?.damaged ?? null,
          restock: restock.get(line.orderLineId) ?? null,
        };
      }),
      receipt: value.receipt
        ? {
            by: person(value.receipt.by),
            at: value.receipt.at,
            evidence: value.receipt.evidence,
          }
        : null,
      inspection: value.inspection
        ? {
            by: person(value.inspection.by),
            at: value.inspection.at,
            evidence: value.inspection.evidence,
          }
        : null,
      proposal: value.proposal
        ? {
            kind: value.proposal.kind,
            by: person(value.proposal.by),
            at: value.proposal.at,
            evidence: value.proposal.evidence,
          }
        : null,
      history: data.events.map((e) => ({
        id: e.id,
        kind: e.kind,
        actor: person(e.actorId),
        at: e.occurredAt,
        evidence: e.evidence,
        details: {
          ...e.details,
          ...(e.details.assigneeId !== undefined
            ? {
                assignee: e.details.assigneeId
                  ? person(e.details.assigneeId)
                  : null,
              }
            : {}),
        },
      })),
      creation: latest ? await creationView(context, latest, people) : null,
      creationAvailability: availability(
        connection,
        value,
        latest,
        data.mapped,
        data.sourceReturn,
      ),
      canManage: hasPermission(context, 'returns.manage'),
      asOf: deps.now().toISOString(),
    };
  }

  async function viewOf(context: TenantContext, creation: ReturnCreation) {
    const people = await deps.store.transaction(context.tenantId, false, (tx) =>
      tx.people([
        creation.requestedBy,
        ...(creation.decidedBy ? [creation.decidedBy] : []),
      ]),
    );

    return creationView(context, creation, people);
  }

  return { admissionReads, creationView, summary, detail, viewOf };
}

export type ReturnCaseViews = ReturnType<typeof createReturnCaseViews>;
