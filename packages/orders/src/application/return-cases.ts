import type { AuditEntry } from '@luma/audit';
import type { WriteAcceptance } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  isAppPermission,
  MembershipSuspendedError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import {
  canonicalJson,
  conflict,
  forbidden,
  invalid,
  notFound,
  ServiceError,
  unavailable,
} from '@luma/platform';
import type { PolicyDecision, ProposedAction } from '@luma/policies';

import {
  cancelCase,
  checkOpenLines,
  type DecisionEvidence,
  lineAvailability,
  proposeResolution,
  recordInspection,
  recordReceipt,
  type ResolutionKind,
  type ReturnableLine,
  type ReturnCase,
  ReturnCaseError,
  type ReturnCaseLine,
  type ReturnCaseReason,
  type ReturnCaseStage,
  returnCaseStage,
  type StoreReturn,
} from '../domain/return-cases.js';
import type { ExchangeConsistencyReport } from '../domain/return-consistency.js';
import {
  type CreationFailure,
  type CreationState,
  type FoundReturn,
  liveCreationStates,
  matchesCreation,
  type ReturnCreation,
  type SourceRef,
} from '../domain/return-creations.js';
import {
  citedReads,
  completeReads,
  type ReturnRead,
  type ReturnReadEvidence,
  returnReadEvidence,
} from '../domain/return-reads.js';
import { returnRecoveryStep } from '../domain/return-recovery.js';
import type { ReturnData } from '../domain/returns.js';
import {
  type ReturnWriteReceipt,
  returnWriteReceipt,
  returnWriteReceiptName,
} from './return-write-receipts.js';

/** One source's current order: its connection, number and lines. */
export interface OrderSource {
  connectionId: string;
  displayNumber: string | null;
  lines: (ReturnableLine & {
    unit: string;
    title: string | null;
    sku: string | null;
  })[];
}

/** A store return record of an order, from its current snapshot. */
export interface SourceReturnRecord extends StoreReturn {
  orderId: string;
  name: string | null;
  source?: SourceRef;
}

export type ReturnCaseEventKind =
  | 'opened'
  | 'assigned'
  | 'receipt_recorded'
  | 'inspection_recorded'
  | 'resolution_proposed'
  | 'cancelled'
  | 'creation_requested'
  | 'creation_approved'
  | 'creation_rejected'
  | 'creation_created'
  | 'exchange_completed'
  | 'exchange_reopened';

/** One append-only entry of a case's history, keyed by the command that caused it. */
export interface ReturnCaseEvent {
  id: string;
  tenantId: string;
  caseId: string;
  commandId: string;
  digest: string;
  kind: ReturnCaseEventKind;
  actorId: string;
  revision: number;
  occurredAt: string;
  evidence: DecisionEvidence | null;
  /** Decision values for this entry: lines, the assignee, a resolution or a reason. */
  details: {
    lines?: {
      orderLineId: string;
      quantity?: number;
      received?: number;
      resellable?: number;
      damaged?: number;
      restock?: number;
    }[];
    assigneeId?: string | null;
    resolution?: ResolutionKind;
    reason?: string;
    creationId?: string;
    externalNumber?: string | null;
  };
}

export interface Person {
  id: string;
  name: string | null;
  member: boolean;
}

/** Reads and writes return cases; every transaction is tenant-scoped. */
export interface ReturnCaseTransaction {
  /** Persisted case search; customer scope follows explicit source order mappings. */
  findCases(query: {
    q: string;
    customerId?: string;
    openOnly?: boolean;
    after?: { at: string; id: string };
    limit: number;
  }): Promise<
    {
      value: ReturnCase;
      orderNumber: string | null;
      creation: ReturnCreation | null;
      assignment: ReturnCaseEvent | null;
      completion?: ExchangeConsistencyReport | null;
      /** The case's exchange, whose completion check `completion` is. */
      exchangeId?: string | null;
      /** The case's latest refund, restock or exchange step. */
      settlement?: SettlementReference | null;
    }[]
  >;
  /** Serializes case changes of one order until the transaction ends. */
  lockOrder(orderId: string): Promise<void>;
  /** Current order snapshots, one per source connection; empty when the order is unknown. */
  orderSources(orderId: string): Promise<OrderSource[]>;
  storeReturns(orderId: string): Promise<SourceReturnRecord[]>;
  sourceReturn(entityId: string): Promise<SourceReturnRecord | null>;
  cases(orderId: string): Promise<ReturnCase[]>;
  case(id: string): Promise<ReturnCase | null>;
  insertCase(value: ReturnCase): Promise<void>;
  /** Saves a case whose stored revision is one lower; returns false when it moved on. */
  saveCase(value: ReturnCase): Promise<boolean>;
  /** Oldest first. */
  events(caseId: string): Promise<ReturnCaseEvent[]>;
  event(commandId: string): Promise<ReturnCaseEvent | null>;
  insertEvent(event: ReturnCaseEvent): Promise<void>;
  /** Newest first. */
  creations(caseId: string): Promise<ReturnCreation[]>;
  creation(id: string): Promise<ReturnCreation | null>;
  insertCreation(value: ReturnCreation): Promise<void>;
  saveCreation(value: ReturnCreation): Promise<void>;
  /** One requester's creations that may need a background step, oldest first, at most 100. */
  liveCreations(requestedBy: string): Promise<ReturnCreation[]>;
  /** The connection's source IDs of the order and the given order lines, when mapped. */
  sourceIds(
    connectionId: string,
    orderId: string,
    orderLineIds: string[],
  ): Promise<{ order: SourceRef | null; lines: Map<string, SourceRef> }>;
  people(ids: string[]): Promise<Map<string, Person>>;
  audit(entry: AuditEntry): Promise<void>;
  /** Stores a cited provider read; an already stored read is kept unchanged. */
  recordRead(evidence: ReturnReadEvidence): Promise<void>;
  /** Stores a write receipt; an already stored receipt is kept unchanged. */
  recordWriteReceipt(receipt: ReturnWriteReceipt): Promise<void>;
}

export interface ReturnCaseStore {
  transaction<T>(
    tenantId: string,
    write: boolean,
    operation: (tx: ReturnCaseTransaction) => Promise<T>,
  ): Promise<T>;
}

/** A connection that can take returns, from its installed capabilities. */
export interface ReturnConnection {
  id: string;
  label: string;
  provider: string | null;
  status: string;
  /** The app offers return creation for this connection. */
  offersCreation: boolean;
  /** Creation, the options read and the created-returns read are all granted. */
  canCreate: boolean;
}

export interface ReturnOption extends SourceRef {
  name: string | null;
}

export type ReturnSystemResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unavailable' | 'denied' | 'busy' | 'failed' };

/** Reads the systems returns can be created in, through installed connections. */
export interface ReturnSystem {
  connections(context: TenantContext): Promise<ReturnConnection[]>;
  options(
    context: TenantContext,
    connectionId: string,
  ): Promise<
    ReturnSystemResult<{ warehouses: ReturnOption[]; reasons: ReturnOption[] }>
  >;
  /**
   * Fresh read of the returns created for a case; `complete` is false when the scan was cut
   * short. `reads` holds the provider read behind each item, named by its observation ID.
   */
  created(
    context: TenantContext,
    connectionId: string,
    query: {
      order: SourceRef;
      lumaCaseId: string;
      requestedReturn?: SourceRef;
    },
  ): Promise<
    ReturnSystemResult<{
      items: FoundReturn[];
      complete: boolean;
      reads: ReturnRead[];
    }>
  >;
}

/** Execution state of a creation action, as Action Admission recorded it. */
export type CreationExecution =
  | { state: 'not_started' }
  | { state: 'not_executed' }
  | { state: 'withheld'; failure: CreationFailure }
  | { state: 'accepted' }
  | { state: 'verified' }
  | { state: 'failed'; failure: CreationFailure }
  | { state: 'uncertain' };

/** A creation's policy decision with its recorded human response. */
export type CreationDecision = PolicyDecision & {
  approval?: { outcome: 'approved' | 'rejected'; approverId: string };
};

/** Binds creations to Action Admission, workspace policy and audited execution. */
export interface CreationAdmission {
  /** Effective workspace and connection write controls, without provider calls. */
  writeMode?(
    context: TenantContext,
    connectionId: string,
  ): Promise<'observe_only' | 'writes_enabled'>;
  /** Binds the action to its admission step and evaluates policy with a fresh precondition check. */
  prepare(
    context: TenantContext,
    creation: ReturnCreation,
    action: ProposedAction,
  ): Promise<PolicyDecision>;
  decision(
    context: TenantContext,
    id: string,
  ): Promise<CreationDecision | null>;
  /** Reads decisions as `decision` does, refreshing authorization once for the whole read. Unknown IDs map to null. */
  decisions(
    context: TenantContext,
    ids: string[],
  ): Promise<Map<string, CreationDecision | null>>;
  respond(
    context: TenantContext,
    decisionId: string,
    outcome: 'approved' | 'rejected',
    expiresAt: string,
  ): Promise<void>;
  /** Dispatches once; repeated calls return the recorded attempt. */
  execute(
    context: TenantContext,
    creation: ReturnCreation,
  ): Promise<CreationExecution>;
  /** Re-runs verification only; never dispatches again. */
  reconcile(
    context: TenantContext,
    creation: ReturnCreation,
  ): Promise<CreationExecution>;
  get(
    context: TenantContext,
    creation: ReturnCreation,
  ): Promise<CreationExecution>;
}

export interface ReturnCaseDependencies {
  store: ReturnCaseStore;
  /** Null when no installed connection can create returns on this server. */
  system: ReturnSystem | null;
  /** Null when execution is disabled; returns can then not be created from Luma. */
  admission: CreationAdmission | null;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Resolves a stored principal's current workspace context for work done on their behalf. */
  principal(
    principalId: string,
    tenantId: string,
    requestId: string,
  ): Promise<TenantContext>;
  digest(value: unknown): string;
  /** Stable UUID derived from a name. */
  uuid(name: string): string;
  now(): Date;
}

export interface CaseCommand {
  commandId: string;
  expectedRevision: number;
}

export interface OpenCaseInput {
  /** The new case ID; it is also the command's idempotency key. */
  id: string;
  connectionId: string;
  sourceReturnId: string | null;
  lines: {
    orderLineId: string;
    quantity: number;
    reason: ReturnCaseReason;
    note: string | null;
  }[];
}

/** Why a case's return can't be created in its order's system now; null when it can. */
export type CreationBlocker =
  | 'completed'
  | 'cancelled'
  | 'execution_disabled'
  | 'unsupported'
  | 'reconnect'
  | 'connection_inactive'
  | 'unmapped'
  | 'in_progress'
  | 'created';

export interface PersonView {
  id: string;
  name: string | null;
}

export interface CreationView {
  operation?: 'create' | 'approve';
  id: string;
  state: CreationState;
  connectionId: string;
  warehouse: { name: string | null };
  reason: { name: string | null };
  lines: { orderLineId: string; quantity: number }[];
  requestedBy: PersonView;
  requestedAt: string;
  expiresAt: string;
  decidedBy: PersonView | null;
  decidedAt: string | null;
  decisionId: string | null;
  approvalOutcome: 'approved' | 'rejected' | null;
  externalReturn: { externalId: string; number: string | null } | null;
  createdAt: string | null;
  failure: CreationFailure | null;
  observeOnly: boolean;
  canApprove: boolean;
  canSend: boolean;
  canCheck: boolean;
}

export interface ReturnCaseSummary {
  id: string;
  orderId: string;
  connectionId: string;
  sourceReturnId: string | null;
  state: ReturnCase['state'];
  stage: ReturnCaseStage;
  units: number;
  assignee: PersonView | null;
  resolution: ResolutionKind | null;
  externalNumber: string | null;
  openedAt: string;
  updatedAt: string;
}

/** A bounded search page of tenant-owned return cases. */
export interface ReturnCaseList {
  items: (ReturnCaseSummary & { orderNumber: string | null })[];
  nextCursor: string | null;
}

/** A refund, restock or exchange step of a return case, by what it does. */
interface SettlementReference {
  kind: 'refund' | 'restock' | 'exchange_step';
  id: string;
}

/** Persisted work and creation controls currently waiting on a person. */
export interface ReturnCaseAttention {
  /** An unresolved completion check of the case's exchange, `exchangeId`. */
  completion?: ExchangeConsistencyReport & { exchangeId: string };
  waiting?: {
    /** The wait occurrence. */
    id?: string;
    dueAt: string;
    reason: string;
    observedAt: string | null;
    ownerId: string;
  };
  case: ReturnCaseSummary & { orderNumber: string | null; revision: number };
  creation: CreationView | null;
  /** The case's latest refund, restock or exchange step, whatever its state. */
  settlement: SettlementReference | null;
  canManage: boolean;
  assignment: {
    assigneeId: string;
    assignedBy: string;
    assignedAt: string;
    revision: number;
  } | null;
}

export interface ReturnCaseDetail {
  case: ReturnCaseSummary & {
    revision: number;
    openedBy: PersonView;
    cancellation: { by: PersonView; at: string; reason: string } | null;
  };
  order: {
    id: string;
    number: string | null;
    connection: { id: string; label: string | null; provider: string | null };
  };
  sourceReturn: { id: string; name: string | null; status: string } | null;
  lines: {
    orderLineId: string;
    title: string | null;
    sku: string | null;
    quantity: number;
    reason: ReturnCaseReason;
    note: string | null;
    received: number | null;
    missing: number | null;
    resellable: number | null;
    damaged: number | null;
    restock: number | null;
  }[];
  receipt: { by: PersonView; at: string; evidence: DecisionEvidence } | null;
  inspection: { by: PersonView; at: string; evidence: DecisionEvidence } | null;
  proposal: {
    kind: ResolutionKind;
    by: PersonView;
    at: string;
    evidence: DecisionEvidence;
  } | null;
  history: {
    id: string;
    kind: ReturnCaseEventKind;
    actor: PersonView;
    at: string;
    evidence: DecisionEvidence | null;
    details: ReturnCaseEvent['details'] & { assignee?: PersonView | null };
  }[];
  creation: CreationView | null;
  creationAvailability: {
    blocker: CreationBlocker | null;
    connection: { id: string; label: string } | null;
  };
  canManage: boolean;
  asOf: string;
}

export interface OrderReturnCases {
  sources: {
    connectionId: string;
    displayNumber: string | null;
    lines: {
      orderLineId: string;
      title: string | null;
      sku: string | null;
      unit: string;
      ordered: number;
      inCases: number;
      inStoreReturns: number;
      returnable: number;
    }[];
    storeReturns: {
      id: string;
      name: string | null;
      status: ReturnData['status'];
      caseId: string | null;
    }[];
  }[];
  cases: ReturnCaseSummary[];
  canManage: boolean;
}

const hour = 3_600_000;

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

function unreadable(): never {
  throw unavailable(
    'The order’s system could not be read. Check the connection in Apps and try again.',
  );
}

/** Runs a domain rule and reports a broken rule as an HTTP error with its message. */
function rule<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof ReturnCaseError)) throw error;
    if (error.code === 'invalid') throw invalid(error.message);
    if (error.code === 'conflict') throw conflict(error.message);
    throw notFound(error.message);
  }
}

const units = (value: ReturnCase) =>
  value.lines.reduce((sum, line) => sum + line.quantity, 0);

/**
 * Owns return cases: opening them against an order's returnable units, assignment, receipt,
 * inspection and proposed resolutions, and an approval-controlled request to create the return
 * in the system the order came from. Every change is revision-checked, idempotent by command ID
 * and audited in the same transaction.
 */
export function createReturnCases(deps: ReturnCaseDependencies) {
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

  /**
   * Runs a change once per command ID inside one write transaction. An exact retry by the same
   * actor changes nothing; a different request with a used ID is a conflict.
   */
  async function command(
    context: TenantContext,
    commandId: string,
    request: unknown,
    operation: (tx: ReturnCaseTransaction, digest: string) => Promise<void>,
  ) {
    const digest = deps.digest({ actorId: context.actor.id, request });
    await deps.store.transaction(context.tenantId, true, async (tx) => {
      const prior = await tx.event(commandId);
      if (prior) {
        if (prior.digest !== digest)
          throw conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return;
      }
      await operation(tx, digest);
    });
  }

  /** Applies a decision to the expected revision and records it in the case history. */
  async function change(
    context: TenantContext,
    caseId: string,
    input: CaseCommand,
    request: unknown,
    kind: ReturnCaseEventKind,
    apply: (
      value: ReturnCase,
      tx: ReturnCaseTransaction,
    ) => Promise<{
      next: ReturnCase;
      evidence: DecisionEvidence | null;
      details: ReturnCaseEvent['details'];
    }>,
  ) {
    await command(
      context,
      input.commandId,
      { caseId, request },
      async (tx, digest) => {
        const value = await tx.case(caseId);
        if (!value) throw notFound('Return case not found');
        if (value.revision !== input.expectedRevision)
          throw conflict('This return case changed. Refresh it and try again.');
        await tx.lockOrder(value.orderId);
        const current = await tx.case(caseId);
        if (!current || current.revision !== input.expectedRevision)
          throw conflict('This return case changed. Refresh it and try again.');
        const applied = await apply(current, tx);
        const next: ReturnCase = {
          ...applied.next,
          revision: value.revision + 1,
          updatedAt: deps.now().toISOString(),
        };
        if (!(await tx.saveCase(next)))
          throw conflict('This return case changed. Refresh it and try again.');
        const entry = event(
          context,
          next,
          input.commandId,
          digest,
          kind,
          applied.evidence,
          applied.details,
        );
        await tx.insertEvent(entry);
        await tx.audit(audit(context, entry, next));
      },
    );

    return detail(context, caseId);
  }

  function decided(context: TenantContext, evidence: DecisionEvidence) {
    return { by: context.actor.id, at: deps.now().toISOString(), evidence };
  }

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

  /**
   * A fresh read of the system; exactly one return carrying the case marker identifies it.
   * `reads` holds the read behind every found return, or is null when one is missing, so none
   * of them can be cited.
   */
  async function locate(context: TenantContext, creation: ReturnCreation) {
    const none = { found: [], complete: false, reads: null };
    if (!deps.system) return none;
    const result = await deps.system.created(context, creation.connectionId, {
      order: creation.order,
      lumaCaseId: creation.caseId,
      ...(creation.requestedReturn
        ? { requestedReturn: creation.requestedReturn }
        : {}),
    });
    if (!result.ok) return none;
    const { items, reads } = result.value;

    return {
      found: items,
      reads: citedReads(
        items.map((f) => f.observationId),
        reads,
      ),
      complete: result.value.complete && completeReads(reads),
    };
  }

  /** Stores the reads a creation cites in the citing transaction. */
  async function recordReads(
    context: TenantContext,
    tx: ReturnCaseTransaction,
    creation: ReturnCreation,
    reads: ReturnRead[],
  ) {
    for (const read of reads)
      await tx.recordRead(
        returnReadEvidence(
          context.tenantId,
          creation.caseId,
          { purpose: 'creation', id: creation.id },
          read,
        ),
      );
  }

  /** Applies an execution result; a verified creation is located again and recorded. */
  async function settle(
    context: TenantContext,
    creationId: string,
    execution: CreationExecution,
  ) {
    const read = () =>
      deps.store.transaction(context.tenantId, false, (tx) =>
        tx.creation(creationId),
      );
    const creation = await read();
    if (!creation || execution.state === 'not_started') return;
    const save = (patch: Partial<ReturnCreation>) =>
      deps.store.transaction(context.tenantId, true, async (tx) => {
        const current = await tx.creation(creationId);
        if (current && current.state !== 'created')
          await saveCreation(tx, current, patch);
      });
    if (execution.state === 'not_executed')
      return save({ state: 'not_executed', failure: null });
    if (execution.state === 'withheld' || execution.state === 'failed')
      return save({ state: 'failed', failure: execution.failure });
    if (execution.state !== 'verified') return save({ state: 'uncertain' });
    const { found, complete, reads } = await locate(context, creation);
    const match = found.length === 1 ? found[0]! : null;
    if (
      !complete ||
      !reads ||
      !match ||
      !Number.isFinite(Date.parse(match.observedAt)) ||
      Date.parse(match.observedAt) < Date.parse(creation.requestedAt) ||
      Date.parse(match.observedAt) > deps.now().getTime() ||
      !matchesCreation(creation, match)
    )
      return save({ state: 'uncertain' });
    await deps.store.transaction(context.tenantId, true, async (tx) => {
      const current = (await tx.creation(creationId))!;
      if (current.state === 'created') return;
      await recordReads(context, tx, current, reads);
      const saved = await saveCreation(tx, current, {
        state: 'created',
        createdAt: match.observedAt,
        externalReturn: { externalId: match.externalId, number: match.number },
        failure: null,
      });
      await creationEvent(
        context,
        tx,
        saved,
        'creation_created',
        { externalNumber: match.number },
        [match.observationId],
      );
    });
  }

  async function dispatch(context: TenantContext, creation: ReturnCreation) {
    if (!deps.admission) return;
    await deps.store.transaction(context.tenantId, true, async (tx) => {
      const current = await tx.creation(creation.id);
      if (current?.state === 'approved')
        await saveCreation(tx, current, { state: 'sending' });
    });
    let execution: CreationExecution;
    try {
      execution = await deps.admission.execute(context, creation);
    } catch {
      execution = await deps.admission
        .get(context, creation)
        .catch(() => ({ state: 'uncertain' }) as const);
      if (execution.state === 'not_started')
        execution = { state: 'failed', failure: 'not_sent' };
    }
    await settle(context, creation.id, execution);
  }

  async function loadCreation(
    context: TenantContext,
    caseId: string,
    creationId: string,
  ) {
    const creation = await deps.store.transaction(
      context.tenantId,
      false,
      (tx) => tx.creation(creationId),
    );
    if (!creation || creation.caseId !== caseId)
      throw notFound('Return creation not found');

    return creation;
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

  const service = {
    /** Lists an order's return cases and what each source can still return. */
    async forOrder(
      context: TenantContext,
      orderId: string,
    ): Promise<OrderReturnCases> {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const sources = await tx.orderSources(orderId);
          if (!sources.length) return null;
          const cases = await tx.cases(orderId);
          // An order has few cases; one transaction runs one query at a time.
          const creations = new Map<string, ReturnCreation[]>();
          for (const item of cases)
            creations.set(item.id, await tx.creations(item.id));

          return {
            sources,
            cases,
            creations,
            storeReturns: await tx.storeReturns(orderId),
            people: await tx.people(
              cases.flatMap((c) => (c.assigneeId ? [c.assigneeId] : [])),
            ),
          };
        },
      );
      if (!data) throw notFound('Order not found');
      const { sources, cases, storeReturns, people, creations } = data;

      return {
        sources: sources.map((source) => {
          const own = storeReturns.filter(
            (r) => r.connectionId === source.connectionId,
          );
          const available = lineAvailability(
            source.lines,
            cases.filter((c) => c.connectionId === source.connectionId),
            own,
          );

          return {
            connectionId: source.connectionId,
            displayNumber: source.displayNumber,
            lines: source.lines.map((line) => ({
              orderLineId: line.id,
              title: line.title,
              sku: line.sku,
              unit: line.unit,
              ...available.get(line.id)!,
            })),
            storeReturns: own.map((r) => ({
              id: r.entityId,
              name: r.name,
              status: r.status,
              caseId:
                cases.find(
                  (c) =>
                    c.sourceReturnId === r.entityId && c.state !== 'cancelled',
                )?.id ?? null,
            })),
          };
        }),
        cases: cases.map((c) => summary(c, creations.get(c.id) ?? [], people)),
        canManage: hasPermission(context, 'returns.manage'),
      };
    },

    /** Searches persisted cases without provider reads; customer filtering also requires customer access. */
    async list(
      context: TenantContext,
      query: {
        q: string;
        customerId?: string;
        openOnly?: boolean;
        cursor?: string;
        limit: number;
      },
    ): Promise<ReturnCaseList> {
      context = await authorize(context);
      if (query.customerId) requirePermission(context, 'customers.read');
      if (
        !Number.isInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 50 ||
        query.q.length > 120
      )
        throw invalid(
          'Choose a page size from 1 to 50 and a search up to 120 characters.',
        );
      const scope = deps.digest([
        context.tenantId,
        query.q,
        query.customerId ?? null,
        !!query.openOnly,
      ]);
      let after: { at: string; id: string } | undefined;
      if (query.cursor) {
        try {
          const decoded: unknown = JSON.parse(
            Buffer.from(query.cursor, 'base64url').toString(),
          );
          if (
            !decoded ||
            typeof decoded !== 'object' ||
            !('scope' in decoded) ||
            decoded.scope !== scope ||
            !('at' in decoded) ||
            typeof decoded.at !== 'string' ||
            !Number.isFinite(Date.parse(decoded.at)) ||
            !('id' in decoded) ||
            typeof decoded.id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              decoded.id,
            )
          )
            throw new Error('Cursor');
          after = { at: decoded.at, id: decoded.id };
        } catch {
          throw invalid(
            'This page link no longer matches the case search. Start from the first page.',
          );
        }
      }

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const rows = await tx.findCases({
          q: query.q,
          ...(query.customerId ? { customerId: query.customerId } : {}),
          ...(query.openOnly ? { openOnly: true } : {}),
          ...(after ? { after } : {}),
          limit: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        const people = await tx.people(
          page.flatMap(({ value }) => [
            value.openedBy,
            ...(value.assigneeId ? [value.assigneeId] : []),
          ]),
        );
        const last = page.at(-1)?.value;

        return {
          items: page.map(({ value, orderNumber, creation }) => ({
            ...summary(value, creation ? [creation] : [], people),
            orderNumber,
          })),
          nextCursor:
            rows.length > query.limit && last
              ? Buffer.from(
                  JSON.stringify({ scope, at: last.updatedAt, id: last.id }),
                ).toString('base64url')
              : null,
        };
      });
    },

    /** Lists bounded, persisted open case attention for the shared decision queue; never reads a provider. */
    async pending(context: TenantContext): Promise<ReturnCaseAttention[]> {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const rows = await tx.findCases({
            q: '',
            openOnly: true,
            limit: 501,
          });
          if (rows.length > 500)
            throw unavailable(
              'Return attention exceeds this view’s read limit. Open return cases from their orders or search.',
            );
          const items = rows.map((row) => ({
            ...row,
            assignment:
              row.value.assigneeId &&
              row.assignment?.details.assigneeId === row.value.assigneeId
                ? {
                    assigneeId: row.value.assigneeId,
                    assignedBy: row.assignment.actorId,
                    assignedAt: row.assignment.occurredAt,
                    revision: row.value.revision,
                  }
                : null,
          }));
          const people = await tx.people(
            items.flatMap(({ value, creation }) => [
              value.openedBy,
              ...(value.assigneeId ? [value.assigneeId] : []),
              ...(creation
                ? [
                    creation.requestedBy,
                    ...(creation.decidedBy ? [creation.decidedBy] : []),
                  ]
                : []),
            ]),
          );

          return { items, people };
        },
      );
      // One authorized admission read covers every listed creation's decision.
      const decisionIds = data.items.flatMap(({ creation }) =>
        creation?.decisionId ? [creation.decisionId] : [],
      );
      const reads = admissionReads(
        context,
        deps.admission && decisionIds.length
          ? await deps.admission.decisions(context, decisionIds)
          : undefined,
      );
      const result: ReturnCaseAttention[] = [];
      for (const {
        value,
        orderNumber,
        creation,
        assignment,
        completion,
        exchangeId,
        settlement,
      } of data.items)
        result.push({
          case: {
            ...summary(value, creation ? [creation] : [], data.people),
            orderNumber,
            revision: value.revision,
          },
          assignment,
          ...(completion?.state === 'unresolved' && exchangeId
            ? {
                completion: {
                  ...completion,
                  exchangeId,
                  ownerId: value.assigneeId ?? value.openedBy,
                },
              }
            : {}),
          creation: creation
            ? await creationView(context, creation, data.people, reads)
            : null,
          settlement: settlement ?? null,
          canManage: hasPermission(context, 'returns.manage'),
        });

      return result;
    },

    /** Reads one return case with its lines, decisions, history and creation state. */
    async get(context: TenantContext, caseId: string) {
      context = await authorize(context);

      return detail(context, caseId);
    },

    /**
     * Opens a case on one source's order lines. Opening is serialized per order, so concurrent
     * cases can never claim more units than are returnable. Linking a store return lets the case
     * work it; the return then counts only through the case.
     */
    async open(context: TenantContext, orderId: string, input: OpenCaseInput) {
      context = await authorize(context, true);
      await command(
        context,
        input.id,
        { orderId, input },
        async (tx, digest) => {
          if (await tx.case(input.id))
            throw conflict(
              'This request ID was already used. Refresh before trying again.',
            );
          await tx.lockOrder(orderId);
          const sources = await tx.orderSources(orderId);
          if (!sources.length) throw notFound('Order not found');
          const source = sources.find(
            (s) => s.connectionId === input.connectionId,
          );
          if (!source)
            throw invalid('Choose order lines from a source of this order.');
          const cases = (await tx.cases(orderId)).filter(
            (c) => c.connectionId === input.connectionId,
          );
          if (input.sourceReturnId) {
            const linked = await tx.sourceReturn(input.sourceReturnId);
            if (
              !linked ||
              linked.orderId !== orderId ||
              linked.connectionId !== input.connectionId
            )
              throw notFound('Store return not found on this order');
            if (['declined', 'cancelled'].includes(linked.status))
              throw conflict('This store return is declined or cancelled.');
            if (
              cases.some(
                (c) =>
                  c.state !== 'cancelled' &&
                  c.sourceReturnId === input.sourceReturnId,
              )
            )
              throw conflict(
                'Another return case already works this store return.',
              );
          }
          const storeReturns = (await tx.storeReturns(orderId)).filter(
            (r) =>
              r.connectionId === input.connectionId &&
              r.entityId !== input.sourceReturnId,
          );
          const byId = new Map(source.lines.map((l) => [l.id, l]));
          const lines: ReturnCaseLine[] = input.lines.map((line) => ({
            orderLineId: line.orderLineId,
            title: byId.get(line.orderLineId)?.title ?? null,
            sku: byId.get(line.orderLineId)?.sku ?? null,
            quantity: line.quantity,
            reason: line.reason,
            note: line.note,
          }));
          rule(() =>
            checkOpenLines(
              lines,
              lineAvailability(source.lines, cases, storeReturns),
            ),
          );
          const now = deps.now().toISOString();
          const value: ReturnCase = {
            id: input.id,
            tenantId: context.tenantId,
            orderId,
            connectionId: input.connectionId,
            sourceReturnId: input.sourceReturnId,
            state: 'open',
            lines,
            assigneeId: null,
            receipt: null,
            inspection: null,
            proposal: null,
            openedBy: context.actor.id,
            openedAt: now,
            cancellation: null,
            revision: 1,
            updatedAt: now,
          };
          await tx.insertCase(value);
          const entry = event(
            context,
            value,
            input.id,
            digest,
            'opened',
            null,
            {
              lines: lines.map((l) => ({
                orderLineId: l.orderLineId,
                quantity: l.quantity,
              })),
            },
          );
          await tx.insertEvent(entry);
          await tx.audit(
            audit(
              context,
              entry,
              value,
              input.sourceReturnId ? [input.sourceReturnId] : [],
            ),
          );
        },
      );

      return detail(context, input.id);
    },

    /** Assigns receiving and inspecting to a current member who can manage returns, or clears it. */
    async assign(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & { assigneeId: string | null },
    ) {
      context = await authorize(context, true);
      if (input.assigneeId) {
        const assignee = await deps
          .principal(
            input.assigneeId,
            context.tenantId,
            `return-case-assignee:${caseId}`,
          )
          .catch(() => null);
        if (!assignee || !hasPermission(assignee, 'returns.manage'))
          throw conflict('Choose a current member who can manage returns.');
      }

      return change(
        context,
        caseId,
        input,
        input,
        'assigned',
        async (value) => {
          if (value.state !== 'open')
            throw conflict(
              'This return case is cancelled. Open a new case instead.',
            );

          return {
            next: { ...value, assigneeId: input.assigneeId },
            evidence: null,
            details: { assigneeId: input.assigneeId },
          };
        },
      );
    },

    /** Records the units that arrived; replaces an earlier receipt and the decisions after it. */
    async recordReceipt(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & {
        lines: { orderLineId: string; received: number }[];
        evidence: DecisionEvidence;
      },
    ) {
      context = await authorize(context, true);
      const actor = context;

      return change(
        context,
        caseId,
        input,
        input,
        'receipt_recorded',
        async (value) => ({
          next: rule(() =>
            recordReceipt(value, {
              ...decided(actor, input.evidence),
              lines: input.lines,
            }),
          ),
          evidence: input.evidence,
          details: { lines: input.lines },
        }),
      );
    },

    /** Judges received units as resellable or damaged; clears an earlier proposal. */
    async recordInspection(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & {
        lines: { orderLineId: string; resellable: number; damaged: number }[];
        evidence: DecisionEvidence;
      },
    ) {
      context = await authorize(context, true);
      const actor = context;

      return change(
        context,
        caseId,
        input,
        input,
        'inspection_recorded',
        async (value) => ({
          next: rule(() =>
            recordInspection(value, {
              ...decided(actor, input.evidence),
              lines: input.lines,
            }),
          ),
          evidence: input.evidence,
          details: { lines: input.lines },
        }),
      );
    },

    /** Proposes a resolution. It is only a proposal; nothing is refunded or restocked. */
    async proposeResolution(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & {
        kind: ResolutionKind;
        lines: { orderLineId: string; restock: number }[];
        evidence: DecisionEvidence;
      },
    ) {
      context = await authorize(context, true);
      const actor = context;

      return change(
        context,
        caseId,
        input,
        input,
        'resolution_proposed',
        async (value) => ({
          next: rule(() =>
            proposeResolution(value, {
              ...decided(actor, input.evidence),
              kind: input.kind,
              lines: input.lines,
            }),
          ),
          evidence: input.evidence,
          details: { resolution: input.kind, lines: input.lines },
        }),
      );
    },

    /**
     * Cancels a case and frees its units. Refused while the return is being created in the
     * order's system; a request still awaiting approval ends with the case.
     */
    async cancel(
      context: TenantContext,
      caseId: string,
      input: CaseCommand & { reason: string },
    ) {
      context = await authorize(context, true);
      const actor = context;

      return change(
        context,
        caseId,
        input,
        input,
        'cancelled',
        async (value, tx) => {
          const creations = await tx.creations(caseId);
          if (
            creations.some((c) =>
              ['approved', 'sending', 'uncertain'].includes(c.state),
            )
          )
            throw conflict(
              'The return is being created in the order’s system. Wait until Luma has checked the result.',
            );
          for (const creation of creations)
            if (creation.state === 'approval_required')
              await saveCreation(tx, creation, {
                state: 'failed',
                failure: 'changed',
              });

          return {
            next: rule(() =>
              cancelCase(value, {
                by: actor.actor.id,
                at: deps.now().toISOString(),
                reason: input.reason,
              }),
            ),
            evidence: null,
            details: { reason: input.reason },
          };
        },
      );
    },

    /** Warehouses and return reasons the case's order system offers, read now. */
    async creationOptions(context: TenantContext, caseId: string) {
      context = await authorize(context, true);
      if (!deps.system || !deps.admission)
        throw unavailable('Creating returns is unavailable on this server.');
      const value = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.case(caseId),
      );
      if (!value) throw notFound('Return case not found');
      const result = await deps.system.options(context, value.connectionId);

      return result.ok ? result.value : unreadable();
    },

    /**
     * Asks for approval to create the case's return in its order's system. The lines, warehouse
     * and reason are fixed now; someone else approves exactly these, and Luma then sends it once.
     */
    async requestCreation(
      context: TenantContext,
      caseId: string,
      input: { id: string; warehouse: SourceRef; reason: SourceRef },
    ) {
      context = await authorize(context, true);
      if (!deps.system || !deps.admission)
        throw unavailable('Creating returns is unavailable on this server.');
      const existing = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.creation(input.id),
      );
      if (existing) {
        if (
          existing.caseId !== caseId ||
          existing.requestedBy !== context.actor.id ||
          canonicalJson([
            existing.warehouse.externalId,
            existing.warehouse.scopeKey,
            existing.reason.externalId,
            existing.reason.scopeKey,
          ]) !==
            canonicalJson([
              input.warehouse.externalId,
              input.warehouse.scopeKey,
              input.reason.externalId,
              input.reason.scopeKey,
            ])
        )
          throw conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return detail(context, caseId);
      }
      const current = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.case(caseId),
      );
      if (!current) throw notFound('Return case not found');
      const options = await deps.system.options(context, current.connectionId);
      const choices = options.ok ? options.value : unreadable();
      const pick = (list: ReturnOption[], ref: SourceRef) =>
        list.find(
          (o) => o.externalId === ref.externalId && o.scopeKey === ref.scopeKey,
        );
      const warehouse = pick(choices.warehouses, input.warehouse);
      const reason = pick(choices.reasons, input.reason);
      if (!warehouse || !reason)
        throw conflict(
          'Choose a warehouse and a return reason from the current lists.',
        );
      if ((await detail(context, caseId)).creationAvailability.blocker)
        throw conflict(
          'The return can’t be created in the order’s system right now.',
        );

      const connection = (await deps.system.connections(context)).find(
        (c) => c.id === current.connectionId,
      );
      const creation = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const value = await tx.case(caseId);
          if (!value || value.state !== 'open')
            throw conflict(
              'This return case is cancelled. Open a new case instead.',
            );
          const live = (await tx.creations(caseId)).find((c) =>
            liveCreationStates.includes(c.state),
          );
          if (
            live &&
            !(
              ['approval_required', 'approved'].includes(live.state) &&
              Date.parse(live.expiresAt) <= deps.now().getTime()
            )
          )
            throw conflict(
              'This return is already being created or was created.',
            );
          if (live) await saveCreation(tx, live, { state: 'expired' });
          const ids = await tx.sourceIds(
            value.connectionId,
            value.orderId,
            value.lines.map((l) => l.orderLineId),
          );
          if (
            !ids.order ||
            value.lines.some((l) => !ids.lines.has(l.orderLineId))
          )
            throw conflict('Some lines are not linked to the order’s system.');
          const sourceReturn = value.sourceReturnId
            ? await tx.sourceReturn(value.sourceReturnId)
            : null;
          if (
            connection?.provider === 'shopify' &&
            sourceReturn &&
            (sourceReturn.status !== 'requested' || !sourceReturn.source)
          )
            throw conflict('Only a requested Shopify return can be approved.');
          const now = deps.now();
          const created: ReturnCreation = {
            id: input.id,
            tenantId: context.tenantId,
            caseId,
            connectionId: value.connectionId,
            order: ids.order,
            ...(connection?.provider === 'shopify' && sourceReturn?.source
              ? { requestedReturn: sourceReturn.source }
              : {}),
            warehouse: {
              externalId: warehouse.externalId,
              scopeKey: warehouse.scopeKey,
              name: warehouse.name,
            },
            reason: {
              externalId: reason.externalId,
              scopeKey: reason.scopeKey,
              name: reason.name,
            },
            lines: value.lines.map((l) => ({
              orderLineId: l.orderLineId,
              source: ids.lines.get(l.orderLineId)!,
              quantity: l.quantity,
            })),
            actionId: deps.uuid(
              `return-creation-action:${context.tenantId}:${input.id}`,
            ),
            decisionId: null,
            requestedBy: context.actor.id,
            requestedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 24 * hour).toISOString(),
            state: 'approval_required',
            externalReturn: null,
            createdAt: null,
            decidedBy: null,
            decidedAt: null,
            failure: null,
            updatedAt: now.toISOString(),
          };
          await tx.insertCreation(created);
          await creationEvent(context, tx, created, 'creation_requested');

          return created;
        },
      );
      let decision: PolicyDecision;
      try {
        decision = await deps.admission.prepare(
          context,
          creation,
          creationAction(creation),
        );
      } catch {
        await deps.store.transaction(context.tenantId, true, async (tx) =>
          saveCreation(tx, creation, { state: 'failed', failure: 'not_sent' }),
        );
        throw unavailable(
          'Approval could not be requested. Nothing was sent. Try again.',
        );
      }
      const saved = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) =>
          saveCreation(tx, creation, {
            decisionId: decision.id,
            ...(decision.outcome === 'denied'
              ? { state: 'failed' as const, failure: 'withheld' as const }
              : decision.outcome === 'allowed'
                ? { state: 'approved' as const }
                : {}),
          }),
      );
      if (
        saved.state === 'approved' ||
        (await deps.admission.writeMode?.(context, saved.connectionId)) ===
          'observe_only'
      )
        await dispatch(context, saved);

      return detail(context, caseId);
    },

    /**
     * Approves or rejects a creation. When the workspace requires independent approval, it comes
     * from someone other than the requester. Luma then dispatches it as the requester, exactly
     * once.
     */
    async decideCreation(
      context: TenantContext,
      caseId: string,
      creationId: string,
      input: { decisionId: string; outcome: 'approved' | 'rejected' },
    ) {
      context = await authorize(context, true);
      if (!deps.admission)
        throw unavailable('Creating returns is unavailable on this server.');
      const creation = await loadCreation(context, caseId, creationId);
      const view = await viewOf(context, creation);
      if (!view.canApprove || creation.decisionId !== input.decisionId)
        throw conflict(
          'This request changed, expired or needs a different approver. Refresh it.',
        );
      await deps.admission.respond(
        context,
        input.decisionId,
        input.outcome,
        creation.expiresAt,
      );
      const decidedCreation = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const saved = await saveCreation(tx, creation, {
            state: input.outcome === 'approved' ? 'approved' : 'rejected',
            decidedBy: context.actor.id,
            decidedAt: deps.now().toISOString(),
          });
          await creationEvent(
            context,
            tx,
            saved,
            input.outcome === 'approved'
              ? 'creation_approved'
              : 'creation_rejected',
          );

          return saved;
        },
      );
      if (decidedCreation.state === 'approved') {
        // The approver gains no execution authority; the requester's current membership is
        // resolved and checked again by admission.
        try {
          const principal = await deps.principal(
            decidedCreation.requestedBy,
            context.tenantId,
            `return-creation:${creationId}`,
          );
          await dispatch(principal, decidedCreation);
        } catch {
          // The requester can send an approved creation themselves.
        }
      }

      return detail(context, caseId);
    },

    /** Sends an approved creation now. Only the requester can dispatch it. */
    async sendCreation(
      context: TenantContext,
      caseId: string,
      creationId: string,
    ) {
      context = await authorize(context, true);
      const creation = await loadCreation(context, caseId, creationId);
      const view = await viewOf(context, creation);
      if (!view.canSend)
        throw conflict('Only the requester can send an approved return.');
      await dispatch(context, creation);

      return detail(context, caseId);
    },

    /** Rechecks an uncertain creation by reading the order's system; never sends again. */
    async checkCreation(
      context: TenantContext,
      caseId: string,
      creationId: string,
    ) {
      context = await authorize(context, true);
      if (!deps.admission)
        throw unavailable('Creating returns is unavailable on this server.');
      const creation = await loadCreation(context, caseId, creationId);
      if (['uncertain', 'sending'].includes(creation.state)) {
        const principal = await deps
          .principal(
            creation.requestedBy,
            context.tenantId,
            `return-creation-check:${creationId}`,
          )
          .catch((error: unknown) => {
            if (error instanceof MembershipSuspendedError)
              throw conflict(
                'The person who requested this return can’t access this workspace right now. Luma checks it after their access is restored.',
              );
            throw error;
          });
        await settle(
          principal,
          creationId,
          await deps.admission.reconcile(principal, creation),
        );
      }

      return detail(context, caseId);
    },

    /**
     * Background step for one requester, run as them: applies an approval the case never
     * stored, sends an approved creation within its approval, expires an unsent one after it,
     * resumes a send the execution ledger never reserved, and settles uncertain ones by reading.
     * It never sends a reserved or expired creation again. Without `returns.manage` it only
     * records expiry.
     */
    async recover(context: TenantContext) {
      requireTenant(context, context.tenantId);
      context = await deps.refreshContext(context);
      const manage = hasPermission(context, 'returns.manage');
      const creations = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.liveCreations(context.actor.id),
      );
      const save = (creation: ReturnCreation, patch: Partial<ReturnCreation>) =>
        deps.store.transaction(context.tenantId, true, async (tx) => {
          const current = await tx.creation(creation.id);
          // Another pass or request moved it on; the next pass sees its new state.
          if (!current || current.state !== creation.state) return null;

          return saveCreation(tx, current, patch);
        });
      const failures: unknown[] = [];
      for (let creation of creations) {
        try {
          let step = returnRecoveryStep(creation, deps.now());
          if (step === 'expire') {
            await save(creation, { state: 'expired' });
            continue;
          }
          if (!step || !manage || !deps.admission) continue;
          if (step === 'decision') {
            const approval = (
              await deps.admission.decision(context, creation.decisionId!)
            )?.approval;
            if (!approval) continue;
            const decided = await deps.store.transaction(
              context.tenantId,
              true,
              async (tx) => {
                const current = await tx.creation(creation.id);
                if (current?.state !== 'approval_required') return null;
                const saved = await saveCreation(tx, current, {
                  state: approval.outcome,
                  decidedBy: approval.approverId,
                  decidedAt: deps.now().toISOString(),
                });
                await creationEvent(
                  context,
                  tx,
                  saved,
                  approval.outcome === 'approved'
                    ? 'creation_approved'
                    : 'creation_rejected',
                  {},
                  [],
                  approval.approverId,
                );

                return saved;
              },
            );
            if (decided?.state !== 'approved') continue;
            creation = decided;
            step = 'send';
          }
          if (step === 'send') {
            await dispatch(context, creation);
            continue;
          }
          const execution = await deps.admission.reconcile(context, creation);
          if (execution.state !== 'not_started')
            await settle(context, creation.id, execution);
          else if (Date.parse(creation.expiresAt) > deps.now().getTime()) {
            // Never reserved: resume the same execution identity under its approval.
            const resumed =
              creation.state === 'sending'
                ? creation
                : await save(creation, { state: 'sending' });
            if (resumed) await dispatch(context, resumed);
          }
          // The approval ended before anything was reserved, so nothing can be dispatched.
          else await save(creation, { state: 'expired' });
        } catch (error) {
          // A refused step stays for the next pass; other failures must not hold up the rest.
          if (!(error instanceof ServiceError)) failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'Some return creations could not be followed up',
        );
    },

    /** Admission hook: the bound creation must still match its open case and approval. */
    async eligible(
      context: TenantContext,
      step: { subject?: { kind: string; id: string }; action: unknown },
    ) {
      if (step.subject?.kind !== 'return_case_creation') return false;

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const creation = await tx.creation(step.subject!.id);
        if (
          !creation ||
          creation.actionId !== (step.action as { id?: string }).id ||
          !['approved', 'sending', 'approval_required'].includes(creation.state)
        )
          return false;
        const value = await tx.case(creation.caseId);
        if (
          !value ||
          value.state !== 'open' ||
          value.connectionId !== creation.connectionId ||
          canonicalJson(value.lines.map((l) => [l.orderLineId, l.quantity])) !==
            canonicalJson(
              creation.lines.map((l) => [l.orderLineId, l.quantity]),
            )
        )
          return false;

        return (
          canonicalJson(creationAction(creation)) === canonicalJson(step.action)
        );
      });
    },

    /**
     * Verification for the execution adapter: a fresh read must find exactly this return. Every
     * read it cites is stored first, so its observation IDs resolve to orders evidence. Only a
     * complete read can pass or fail it; a storage failure throws, which execution treats as
     * unknown.
     */
    async verify(context: TenantContext, creationId: string) {
      const creation = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.creation(creationId),
      );
      if (!creation)
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      const { found, complete, reads } = await locate(context, creation);
      if (
        !complete ||
        !reads ||
        found.length === 0 ||
        found.some(
          (f) =>
            !Number.isFinite(Date.parse(f.observedAt)) ||
            Date.parse(f.observedAt) < Date.parse(creation.requestedAt) ||
            Date.parse(f.observedAt) > deps.now().getTime(),
        )
      )
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      await deps.store.transaction(context.tenantId, true, (tx) =>
        recordReads(context, tx, creation, reads),
      );
      if (found.length > 1)
        return {
          outcome: 'failed' as const,
          observationRefs: found.map((f) => f.observationId),
        };

      return {
        outcome: matchesCreation(creation, found[0]!)
          ? ('passed' as const)
          : ('failed' as const),
        observationRefs: [found[0]!.observationId],
      };
    },

    /**
     * Stores the provider's acceptance of a return creation as orders' write receipt and
     * returns its ID, which execution cites. It records what already happened, so it does not
     * recheck authority. Throws when the creation is unknown or the acceptance belongs to
     * another connection; execution then cites nothing and the outcome stays unknown.
     */
    async storeWriteReceipt(
      context: TenantContext,
      creationId: string,
      acceptance: WriteAcceptance,
    ) {
      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const creation = await tx.creation(creationId);
        if (
          !creation ||
          creation.connectionId !== acceptance.connectionId ||
          acceptance.capability !== 'returns.create'
        )
          throw conflict('The receipt does not belong to this return request.');
        const receipt = returnWriteReceipt(
          context.tenantId,
          creation.caseId,
          { purpose: 'creation', id: creation.id },
          deps.uuid(returnWriteReceiptName(context.tenantId, acceptance)),
          acceptance,
        );
        await tx.recordWriteReceipt(receipt);

        return receipt.id;
      });
    },

    /** The creation an action belongs to, for execution adapters. */
    async creationForAction(context: TenantContext, creationId: string) {
      const creation = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.creation(creationId),
      );

      return creation ? { creation, action: creationAction(creation) } : null;
    },
  };

  return service;
}

/** The exact action a creation asks admission to perform. */
function creationAction(creation: ReturnCreation): ProposedAction {
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

export type ReturnCases = ReturnType<typeof createReturnCases>;
