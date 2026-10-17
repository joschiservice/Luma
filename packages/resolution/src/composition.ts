import { createHash, randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { compilePlaybook, playbookHash } from '@luma/workflows/composition';

import { createActivityService } from './application/activity.js';
import { createDecisionAssignmentService } from './application/decision-assignments.js';
import { createImprovementDiscovery } from './application/improvement-discovery.js';
import type { LearningService, LearningStore } from './application/learning.js';
import { createLearningService } from './application/learning.js';
import { createMeasurementService } from './application/measurement.js';
import { createShadowService } from './application/shadow.js';
import { learningBoundary } from './infrastructure/learning-validation.js';
import { measurementCommandSchema } from './infrastructure/measurement-validation.js';
import { createActivityStore } from './infrastructure/persistence/activity.js';
import { readPeople } from './infrastructure/persistence/actors.js';
import { createDecisionAssignmentStore } from './infrastructure/persistence/decision-assignments.js';
import { createImprovementDiscoveryReader } from './infrastructure/persistence/improvement-discovery.js';
import { createLearningStore } from './infrastructure/persistence/learning.js';
import { createMeasurementStore } from './infrastructure/persistence/measurement.js';
import { createShadowStore } from './infrastructure/persistence/shadow.js';
import { shadowBoundary } from './infrastructure/shadow-validation.js';

export { createExceptionActivities } from './application/runtime.js';

export { createResolutionMetricReader } from './infrastructure/persistence/measurement.js';

export { createOperationsOverview } from './application/overview.js';

export { createDeskStore } from './infrastructure/persistence/desk.js';

export {
  caseCitations,
  caseRecords,
} from './infrastructure/persistence/case-evidence.js';

export { createDetectionSources } from './infrastructure/persistence/detection-sources.js';

export { createStockProtectionHoldReader } from './infrastructure/persistence/stock-protection-holds.js';

/** Composes explicit review-only discovery from authoritative retained learning and environment facts. */
export function createResolutionImprovementDiscovery(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  enabled: (tenantId: string) => Promise<boolean>,
  now: () => Date = () => new Date(),
) {
  return createImprovementDiscovery({
    read: createImprovementDiscoveryReader(db),
    refreshContext,
    enabled,
    now,
    hash: playbookHash,
  });
}

export {
  planActiveDiagnosis,
  activeDiagnosisPublication,
} from './infrastructure/active-diagnosis.js';

export { createDeskService } from './application/desk.js';

/** Composes freshly authorized measurement commands with the append-only evidence ledger. */
export function createResolutionMeasurements(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  now = () => new Date(),
) {
  return createMeasurementService({
    store: createMeasurementStore(db, now),
    refreshContext,
    parse: (input) => measurementCommandSchema.parse(input),
  });
}

/**
 * Creates persistent resolution learning with fresh authorization and validated commands and
 * responses.
 */
export function createResolutionLearning(
  db: import('@luma/platform').TenantDatabase,
  refreshContext: (
    context: import('@luma/identity').TenantContext,
  ) => Promise<import('@luma/identity').TenantContext>,
  now: () => Date = () => new Date(),
): LearningService {
  return createLearningCommands(createLearningStore(db, now), refreshContext);
}

/** Composes authorized learning commands with validation and an atomic storage adapter. */
export function createLearningCommands(
  store: LearningStore,
  refreshContext: (
    context: import('@luma/identity').TenantContext,
  ) => Promise<import('@luma/identity').TenantContext>,
): LearningService {
  return createLearningService({ store, refreshContext, ...learningBoundary });
}

/**
 * Names the people behind recorded user IDs in the caller's workspace, as Activity names them,
 * in one query. Callers authorize the read that referenced the IDs.
 */
export function createWorkspacePeople(db: TenantDatabase) {
  return (
    context: TenantContext,
    ids: readonly (string | null | undefined)[],
  ) =>
    db.transaction(context.tenantId, (tx) =>
      readPeople(tx, context.tenantId, ids),
    );
}

/** The audit entry an activity export appends, shaped as the audit log stores it. */
interface ActivityExportAuditEntry {
  id: string;
  tenantId: string;
  eventKey: string;
  eventType: string;
  schemaVersion: 1;
  occurredAt: string;
  actor: { kind: 'user'; id: string };
  correlationId: string;
  proposalId: string;
  actionHash: string;
  evidenceRefs: string[];
  details: Record<string, string>;
}

/**
 * Composes the workspace activity reader with refreshed membership. Each export is appended to
 * `audit` as a list export of the `activity` domain, with its size but without its values;
 * without an audit log, exports are refused.
 */
export function createWorkspaceActivity(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  audit?: { append(entry: ActivityExportAuditEntry): Promise<void> },
) {
  return createActivityService(
    createActivityStore(db),
    refreshContext,
    audit
      ? {
          record: async (_context, entry) => {
            const details = {
              domain: 'activity',
              rows: String(entry.rows),
              truncated: String(entry.truncated),
              filters: String(entry.filters),
            };
            await audit.append({
              id: entry.id,
              tenantId: entry.tenantId,
              eventKey: `collection-export:${entry.id}`,
              eventType: 'collections.exported',
              schemaVersion: 1,
              occurredAt: entry.occurredAt,
              actor: { kind: 'user', id: entry.actorId },
              correlationId: entry.id,
              proposalId: entry.id,
              actionHash: createHash('sha256')
                .update(JSON.stringify(details))
                .digest('hex'),
              evidenceRefs: [],
              details,
            });
          },
          id: randomUUID,
          now: () => new Date(),
        }
      : undefined,
  );
}

/** Composes persistent Shadow evaluations without an execution registry. */
export function createShadowEvaluations(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  now: () => Date = () => new Date(),
) {
  return createShadowService({
    store: createShadowStore(db, { compilePlaybook, playbookHash }),
    refreshContext,
    now,
    ...shadowBoundary,
  });
}

export {
  createPlaybooks,
  compilePlaybook,
  definePlaybook,
  parsePlaybookCode,
  printPlaybookCode,
  createPlaybookStore,
  activationRequestSchema,
  createPlaybookService,
  parsePlaybookSnapshot,
  playbookHash,
} from '@luma/workflows/composition';

export { createActivityStore } from './infrastructure/persistence/activity.js';

/**
 * Composes Needs you assignments. `pending` must answer from the decision queue, and `members`
 * from identity, both for the refreshed reader.
 */
export function createDecisionAssignments(
  db: TenantDatabase,
  deps: Omit<
    Parameters<typeof createDecisionAssignmentService>[0],
    'store' | 'now'
  >,
  now: () => Date = () => new Date(),
) {
  return createDecisionAssignmentService({
    ...deps,
    store: createDecisionAssignmentStore(db),
    now,
  });
}

export { createRefundFollowUpCursor } from './infrastructure/refund-follow-up-cursor.js';
