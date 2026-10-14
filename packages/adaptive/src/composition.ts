import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { createCollectionStatesService } from './application/collection-states.js';
import { createViewExports } from './application/exports.js';
import { createFieldsService } from './application/fields.js';
import { createFieldsEffects } from './application/fields-effects.js';
import type { FieldWorkflowAdapter } from './application/fields-workflows.js';
import { createFieldsWorkflowAdapter } from './application/fields-workflows.js';
import type { AdaptiveViews, ViewsDependencies } from './application/views.js';
import { createViewsService } from './application/views.js';
import { createCollectionStatesStore } from './infrastructure/collection-states.js';
import { collectionsValidation } from './infrastructure/collections-validation.js';
import { createFieldsStore } from './infrastructure/fields.js';
import {
  customFieldValueSchema,
  validateCustomField,
  validateCustomFieldValue,
} from './infrastructure/fields-validation.js';
import { createFieldsWorkflowQueries } from './infrastructure/fields-workflow-queries.js';
import { createViewsStore } from './infrastructure/views.js';
import {
  viewDraftModelSchema,
  viewsValidation,
} from './infrastructure/views-validation.js';

/** Composes custom fields using the shared tenant database and refreshed identity. */
export function createAdaptiveFields(
  db: TenantDatabase,
  options: {
    refreshContext(context: TenantContext): Promise<TenantContext>;
    released(context: TenantContext): Promise<boolean>;
    audit?: (db: TenantDatabase) => AuditLog;
  },
) {
  return createFieldsService({
    store: createFieldsStore(db, options.audit),
    parseField: validateCustomField,
    parseValue: validateCustomFieldValue,
    ...options,
    id: randomUUID,
    now: () => new Date(),
  });
}

export { createAdaptiveActions } from './infrastructure/actions.js';

export { createAdaptivePackages } from './infrastructure/package-service.js';

export { createPackageStore } from './infrastructure/packages.js';

export { configurePurchasingPackage } from './infrastructure/package-configuration.js';

/** Composes reviewed saved queries and constrained model drafting with approved adapters. */
export function createAdaptiveViews(
  db: TenantDatabase,
  options: Omit<
    ViewsDependencies,
    'store' | 'validation' | 'draftSchema' | 'id' | 'now'
  >,
) {
  return createViewsService({
    ...options,
    store: createViewsStore(db),
    validation: viewsValidation,
    draftSchema: viewDraftModelSchema,
    id: randomUUID,
    now: () => new Date(),
  });
}

export { createAdaptiveViewReadAdapter } from './infrastructure/views-query.js';

/**
 * Composes list exports over the saved-view reads. Each export appends an audit entry with the
 * list, row count, columns and number of conditions; exported values are never stored.
 */
export function createViewExportsService(options: {
  views: AdaptiveViews;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  audit: AuditLog;
}) {
  return createViewExports({
    preview: (context, query, cursor) =>
      options.views.preview(context, query, cursor),
    refreshContext: options.refreshContext,
    record: async (_context, entry) => {
      const details = {
        domain: entry.domain,
        rows: String(entry.rows),
        truncated: String(entry.truncated),
        columns: entry.columns.join(','),
        conditions: String(entry.conditions),
      };
      await options.audit.append({
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
  });
}

/** Composes each member's remembered list state, stored under tenant row security. */
export function createCollectionStates(
  db: TenantDatabase,
  options: {
    refreshContext(context: TenantContext): Promise<TenantContext>;
  },
) {
  return createCollectionStatesService({
    store: createCollectionStatesStore(db),
    refreshContext: options.refreshContext,
    validation: collectionsValidation,
    now: () => new Date(),
  });
}

export { createActionReceipts } from './infrastructure/action-receipts.js';

/** Composes a local effect adapter that is callable only after shared Action Admission. */
export function createAdaptiveFieldEffects(
  fields: ReturnType<typeof createAdaptiveFields>,
) {
  return createFieldsEffects(
    fields,
    validateCustomFieldValue,
    () => new Date(),
  );
}

/** Composes typed workflow reads and admission-bound custom field writes. */
export function createAdaptiveFieldWorkflows(
  db: TenantDatabase,
  options: Omit<
    Parameters<typeof createFieldsWorkflowAdapter>[0],
    | 'parseValue'
    | 'parseStoredValue'
    | 'id'
    | 'now'
    | 'pendingReferences'
    | 'latestDecisionId'
  >,
): FieldWorkflowAdapter {
  const queries = createFieldsWorkflowQueries(db);

  return createFieldsWorkflowAdapter({
    ...options,
    parseStoredValue: (value) => customFieldValueSchema.parse(value),
    pendingReferences: queries.pending,
    latestDecisionId: queries.latestDecisionId,
    parseValue: validateCustomFieldValue,
    now: () => new Date(),
    id: (value) => {
      const hex = createHash('sha256').update(value).digest('hex');

      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    },
  });
}
