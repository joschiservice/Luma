import { createHash } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import { createAuditLog } from '@luma/audit/composition';
import { createCommerceIngestion } from '@luma/commerce-ingestion';
import type { EffectRegistry } from '@luma/connections';
import {
  createProductIdentityReader,
  createSourceRecords,
} from '@luma/connections/composition';
import type { DiagnosisOptions, VerificationEvaluator } from '@luma/exceptions';
import {
  createCaseEscalation,
  createCases,
  createDiagnoses,
  createExceptions,
} from '@luma/exceptions/composition';
import type { BoundActionStep } from '@luma/execution';
import {
  createAdmission,
  createAdmissionStore,
  createExecution,
  parseAction,
} from '@luma/execution/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import { createCommerceProjections as createInventoryProjections } from '@luma/inventory/composition';
import { createCommerceProjections as createOrderProjections } from '@luma/orders/composition';
import type { TenantDatabase } from '@luma/platform';
import { createTenantDatabase } from '@luma/platform/composition';
import type { PolicyEvidence, ProposedAction } from '@luma/policies';
import { createPolicies } from '@luma/policies/composition';
import type { DeskDependencies } from '@luma/resolution';
import { createDetectionPipeline } from '@luma/resolution';
import {
  createDeskService,
  createDeskStore,
  createPlaybooks,
} from '@luma/resolution/composition';
import { Pool } from 'pg';

/** Creates the policy and execution services used by workflow activities. */
export function createSafetyServices(
  database: string | TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext'>,
  registry: EffectRegistry,
  admissionOptions: {
    eligible(context: TenantContext, step: BoundActionStep): Promise<boolean>;
  } = { eligible: async () => false },
) {
  const { db, close } = serviceDatabase(database, 10);
  const audit = createAuditLog(db);
  const policies = createPolicies(
    db,
    identity.refreshContext,
    policyAudit(audit),
  );
  const provisioning = createAdmissionStore(db);
  const engine = createExecution(
    db,
    policies,
    audit,
    registry,
    identity.refreshContext,
  );

  return {
    policies,
    provisioning,
    execution: createAdmission({
      repository: provisioning,
      execution: engine,
      refreshContext: identity.refreshContext,
      eligible: admissionOptions.eligible,
    }),
    close,
  };
}

/** Create tenant-scoped detection services for connector ingestion and durable workflow events. */
export function createDetectionServices(
  database: string | TenantDatabase,
  now: () => Date = () => new Date(),
  verifier?: VerificationEvaluator,
  diagnosisOptions: DiagnosisOptions = {},
): {
  exceptions: ReturnType<typeof createExceptions>;
  cases: ReturnType<typeof createCases>;
  diagnoses: ReturnType<typeof createDiagnoses>;
  pipeline: ReturnType<typeof createDetectionPipeline>;
  close(): Promise<void>;
} {
  const { db, close } = serviceDatabase(database);
  const exceptions: ReturnType<typeof createExceptions> = createExceptions(
    db,
    now,
    verifier,
  );

  return {
    exceptions,
    cases: createCases(db, now, createProductIdentityReader(db)),
    diagnoses: createDiagnoses(db, now, diagnosisOptions),
    pipeline: createDetectionPipeline(exceptions, (value) =>
      createHash('sha256').update(value).digest('hex'),
    ),
    close,
  };
}

/** Persist connector observations and replay canonical projections in owner transactions. */
export function createCommerceServices(database: string | TenantDatabase) {
  const { db, close } = serviceDatabase(database);
  const inventory = createInventoryProjections(db);
  const orders = createOrderProjections(db, (context, kind, id) =>
    inventory.has(context, kind, id),
  );
  const sources = createSourceRecords(db, async (context, kind, id) =>
    kind === 'order' ||
    kind === 'order_line' ||
    kind === 'fulfillment' ||
    kind === 'return' ||
    kind === 'refund'
      ? orders.has(context, kind, id)
      : kind === 'customer'
        ? false
        : inventory.has(context, kind, id),
  );

  return {
    sources,
    orders,
    inventory,
    ingestion: createCommerceIngestion(sources, orders, inventory, (value) =>
      createHash('sha256').update(value).digest('hex'),
    ),
    close,
  };
}

/** Connect the operator boundary to persisted proposals and the existing policy authority. */
export function createDeskServices(
  db: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext'>,
  effects: EffectRegistry = { resolve: async () => null },
  options: {
    capability?: (action: ProposedAction) => boolean;
    workflow?: DeskDependencies['workflow'];
    refreshProposal?: DeskDependencies['refreshProposal'];
    notifyDecision?: DeskDependencies['notifyDecision'];
    now?: () => Date;
  } = {},
): ReturnType<typeof createDeskService> {
  const store = createDeskStore(db, {
    parseAction,
    escalate: (scoped, context, id, revision) =>
      createCaseEscalation(scoped)(context, id, revision),
    policies: (scoped) =>
      createPolicies(
        scoped,
        identity.refreshContext,
        policyAudit(createAuditLog(scoped)),
      ),
  });

  return createDeskService({
    store,
    refreshContext: identity.refreshContext,
    capability: options.capability ?? (() => false),
    checkCapability: async (context, action) => {
      const adapter = await effects.resolve(context, action);

      return (
        !!adapter &&
        adapter.capability === action.capability &&
        adapter.version === action.capabilityVersion &&
        (await adapter.checkPreconditions(action))
      );
    },
    now: options.now ?? (() => new Date()),
    ...(options.workflow ? { workflow: options.workflow } : {}),
    ...(options.refreshProposal
      ? { refreshProposal: options.refreshProposal }
      : {}),
    ...(options.notifyDecision
      ? { notifyDecision: options.notifyDecision }
      : {}),
  });
}

/**
 * Returns an audit writer for policy decisions and approvals, preserving their actor and
 * proposal references.
 */
export function policyAudit(audit: AuditLog) {
  return async (evidence: PolicyEvidence) => {
    const item = evidence.document;
    await audit.append({
      id: item.id,
      tenantId: item.tenantId,
      eventKey: item.id,
      eventType: evidence.type,
      schemaVersion: 1,
      occurredAt: 'evaluatedAt' in item ? item.evaluatedAt : item.createdAt,
      actor: {
        kind: 'user',
        id: 'actorId' in item ? item.actorId : item.approverId,
      },
      correlationId: item.correlationId,
      proposalId: item.proposalId,
      actionHash: item.actionHash,
      policyDecisionId: 'actorId' in item ? item.id : item.decisionId,
      evidenceRefs: [],
      details: {
        outcome: item.outcome,
        policyVersion: item.policyVersion,
        ...('reason' in item
          ? { reason: item.reason }
          : { requesterId: item.requesterId, expiresAt: item.expiresAt }),
      },
    });
  };
}

/** Trusted composition publishes and activates playbooks; activities receive only the service. */
export function createResolutionPlaybooks(
  db: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext'>,
  safety: Pick<
    ReturnType<typeof createSafetyServices>,
    'execution' | 'provisioning'
  >,
  now: () => Date = () => new Date(),
) {
  return createPlaybooks(
    db,
    {
      admission: safety.execution,
      provisioning: safety.provisioning,
      refreshContext: identity.refreshContext,
      parseAction,
    },
    now,
  );
}

function serviceDatabase(database: string | TenantDatabase, max = 5) {
  if (typeof database !== 'string')
    return { db: database, close: () => Promise.resolve() };
  const pool = new Pool({
    connectionString: database,
    max,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });

  return { db: createTenantDatabase(pool), close: () => pool.end() };
}
