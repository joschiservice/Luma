import { createHash } from 'node:crypto';

import { Pool } from 'pg';

import { createAuditLog } from '#modules/audit/composition';
import type { AuditLog } from '#modules/audit/index';
import { createSourceRecords } from '#modules/connectors/composition';
import type { EffectRegistry } from '#modules/connectors/index';
import {
  createCaseEscalation,
  createCases,
  createDiagnoses,
  createExceptions,
} from '#modules/exceptions/composition';
import type {
  DiagnosisOptions,
  VerificationEvaluator,
} from '#modules/exceptions/index';
import {
  createAdmission,
  createAdmissionStore,
  createExecution,
  parseAction,
} from '#modules/execution/composition';
import type { BoundActionStep } from '#modules/execution/index';
import type { IdentityService, TenantContext } from '#modules/identity/index';
import { createCommerceProjections as createInventoryProjections } from '#modules/inventory/composition';
import { createCommerceProjections as createOrderProjections } from '#modules/orders/composition';
import { createTenantDatabase } from '#modules/platform/composition';
import type { TenantDatabase } from '#modules/platform/index';
import { createPolicies } from '#modules/policies/composition';
import type { PolicyEvidence, ProposedAction } from '#modules/policies/index';
import {
  createDeskService,
  createDeskStore,
  createPlaybooks,
} from '#modules/workflows/composition';
import type { DeskDependencies } from '#modules/workflows/index';
import {
  createCommerceIngestion,
  createDetectionPipeline,
} from '#modules/workflows/index';

/** Creates the policy and execution services used by workflow activities. */
export function createSafetyServices(
  databaseUrl: string,
  identity: Pick<IdentityService, 'refreshContext'>,
  registry: EffectRegistry,
  admissionOptions: {
    eligible(context: TenantContext, step: BoundActionStep): Promise<boolean>;
  } = { eligible: async () => false },
) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  const db = createTenantDatabase(pool);
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
    close: () => pool.end(),
  };
}

/** Create tenant-scoped detection services for connector ingestion and durable workflow events. */
export function createDetectionServices(
  databaseUrl: string,
  now: () => Date = () => new Date(),
  verifier?: VerificationEvaluator,
  diagnosisOptions: DiagnosisOptions = {},
) {
  const pool = new Pool({ connectionString: databaseUrl });
  const exceptions = createExceptions(
    createTenantDatabase(pool),
    now,
    verifier,
  );

  return {
    exceptions,
    cases: createCases(createTenantDatabase(pool), now),
    diagnoses: createDiagnoses(
      createTenantDatabase(pool),
      now,
      diagnosisOptions,
    ),
    pipeline: createDetectionPipeline(exceptions, (value) =>
      createHash('sha256').update(value).digest('hex'),
    ),
    close: () => pool.end(),
  };
}

/** Persist connector observations and replay canonical projections in owner transactions. */
export function createCommerceServices(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = createTenantDatabase(pool);
  const inventory = createInventoryProjections(db);
  const orders = createOrderProjections(db, (context, id) =>
    inventory.has(context, 'sku', id),
  );
  const sources = createSourceRecords(db, (context, kind, id) =>
    kind === 'order' || kind === 'order_line' || kind === 'fulfillment'
      ? orders.has(context, kind, id)
      : inventory.has(context, kind, id),
  );

  return {
    sources,
    orders,
    inventory,
    ingestion: createCommerceIngestion(sources, orders, inventory, (value) =>
      createHash('sha256').update(value).digest('hex'),
    ),
    close: () => pool.end(),
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
    now?: () => Date;
  } = {},
) {
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
