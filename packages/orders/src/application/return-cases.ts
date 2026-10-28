import type { AuditEntry } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import type { PolicyDecision, ProposedAction } from '@luma/policies';

import type {
  DecisionEvidence,
  ResolutionKind,
  ReturnableLine,
  ReturnCase,
  ReturnCaseReason,
  ReturnCaseStage,
  StoreReturn,
} from '../domain/return-cases.js';
import type { ExchangeConsistencyReport } from '../domain/return-consistency.js';
import type {
  CreationFailure,
  CreationState,
  FoundReturn,
  ReturnCreation,
  SourceRef,
} from '../domain/return-creations.js';
import type { ReturnRead, ReturnReadEvidence } from '../domain/return-reads.js';
import type { ReturnData } from '../domain/returns.js';
import { createReturnCaseLifecycle } from './return-case-lifecycle.js';
import { createReturnCaseReads } from './return-case-reads.js';
import { createReturnCaseSupport } from './return-case-support.js';
import { createReturnCaseViews } from './return-case-views.js';
import { createReturnCreationExecution } from './return-creation-execution.js';
import { createReturnCreationHooks } from './return-creation-hooks.js';
import { createReturnCreationRecovery } from './return-creation-recovery.js';
import { createReturnCreationRequests } from './return-creation-requests.js';
import type { ReturnWriteReceipt } from './return-write-receipts.js';

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

/**
 * Owns return cases: opening them against an order's returnable units, assignment, receipt,
 * inspection and proposed resolutions, and an approval-controlled request to create the return
 * in the system the order came from. Every change is revision-checked, idempotent by command ID
 * and audited in the same transaction.
 */
export function createReturnCases(deps: ReturnCaseDependencies) {
  const support = createReturnCaseSupport(deps);
  const views = createReturnCaseViews(deps);
  const execution = createReturnCreationExecution(deps, support);

  return {
    ...createReturnCaseReads(deps, support, views),
    ...createReturnCaseLifecycle(deps, support, views),
    ...createReturnCreationRequests(deps, support, views, execution),
    ...createReturnCreationRecovery(deps, support, execution),
    ...createReturnCreationHooks(deps, execution),
  };
}

export type ReturnCases = ReturnType<typeof createReturnCases>;
