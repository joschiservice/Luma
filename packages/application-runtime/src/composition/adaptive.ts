import { createHash } from 'node:crypto';

import type {
  AdaptiveFields,
  AdaptiveViews,
  CollectionStates,
  OperationalPackages,
  PackageResource,
  ViewActionCapability,
  ViewActions,
  ViewExports,
  ViewReadAdapter,
  ViewReaderDomain,
} from '@luma/adaptive';
import {
  purchasingPackage,
  purchasingPackageNext,
  viewReaderColumns,
  viewReaderDomains,
  viewReaderKeys,
} from '@luma/adaptive';
import {
  configurePurchasingPackage,
  createActionReceipts,
  createAdaptiveActions,
  createAdaptiveFields,
  createAdaptivePackages,
  createAdaptiveViewReadAdapter,
  createAdaptiveViews,
  createCollectionStates,
  createPackageStore,
  createViewExportsService,
} from '@luma/adaptive/composition';
import {
  adaptiveViewInputSchema,
  caseQuerySchema,
  customerQuerySchema,
  decisionQuerySchema,
  fulfillmentQuerySchema,
  inventoryQuerySchema,
  orderListQuerySchema,
  productQuerySchema,
  purchaseOrderListQuerySchema,
  returnQuerySchema,
  upgradeAdaptiveViewQuery,
} from '@luma/api-contract';
import { createAuditLog } from '@luma/audit/composition';
import type { CaseService } from '@luma/exceptions';
import type { IdentityService, TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  isPermission,
  requirePermission,
} from '@luma/identity';
import { createRoleIdentityReader } from '@luma/identity/composition';
import type {
  FeatureFlag,
  ModelGateway,
  Observability,
  TenantDatabase,
} from '@luma/platform';
import { canonicalJson } from '@luma/platform';
import type { ProcurementService } from '@luma/procurement';
import type {
  SupplierCommitments,
  SupplierEmail,
} from '@luma/procurement/composition';
import type {
  CustomerWorkspace,
  DecisionQueue,
  FulfillmentWorkspace,
  InventoryWorkspace,
  OrderWorkspace,
  ProductWorkspace,
  ReturnWorkspace,
} from '@luma/read-models';
import { createAdaptiveViewIdentities } from '@luma/read-models/composition';
import type { WorkflowCatalog } from '@luma/workflows';
import {
  compileProcessWorkflow,
  createPackageWorkflowArchive,
  createWorkflowCatalogStore,
} from '@luma/workflows/composition';
import { z } from 'zod';

import { createTenantFeatureRelease } from './feature-release.js';

function sourceWarnings(sources: readonly unknown[]): string[] {
  return sources.flatMap((source) => {
    if (!source || typeof source !== 'object') return [];
    const value = z
      .object({
        label: z.string().optional(),
        state: z.string().optional(),
        status: z.string().optional(),
        access: z.string().optional(),
        failing: z.boolean().optional(),
        importing: z.boolean().optional(),
        fullReadAt: z.string().nullable().optional(),
      })
      .safeParse(source);
    if (!value.success) return [];
    const item = value.data,
      label = item.label ?? 'A record source';
    if (
      item.state === 'unavailable' ||
      item.failing ||
      ['degraded', 'revoked', 'disconnected', 'unavailable'].includes(
        item.status ?? '',
      )
    )
      return [`${label} is unavailable or failing. Results may be incomplete.`];
    if (item.access && item.access !== 'granted')
      return [`${label} does not grant access to these records.`];
    if (item.importing || item.fullReadAt === null)
      return [`${label} has not completed its import. Results are partial.`];

    return [];
  });
}

function uuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface AdaptiveWorkspaceRuntime {
  fields: AdaptiveFields;
  views: AdaptiveViews;
  actions: ViewActions;
  packages: OperationalPackages;
  collections: CollectionStates;
  exports: ViewExports;
  availability(context: TenantContext): Promise<{
    fields: boolean;
    views: boolean;
    generation: boolean;
    actions: boolean;
    packages: boolean;
  }>;
}

/** Composes adaptive definitions with the same record readers and governed owner commands. */
export function createAdaptiveWorkspaceRuntime(options: {
  database: TenantDatabase;
  identity: Pick<IdentityService, 'refreshContext'>;
  observability?: Observability;
  model?: ModelGateway;
  modelAvailable?: boolean;
  owners: {
    orders: OrderWorkspace;
    inventory: InventoryWorkspace;
    fulfillment: FulfillmentWorkspace;
    returns: ReturnWorkspace;
    customers: CustomerWorkspace;
    products: ProductWorkspace;
    decisions: DecisionQueue;
    cases: CaseService;
    procurement: ProcurementService;
    commitments: SupplierCommitments;
    supplierEmail: SupplierEmail;
    workflows: WorkflowCatalog;
  };
}): AdaptiveWorkspaceRuntime {
  const { database, identity, owners } = options;
  const release = createTenantFeatureRelease(options.observability);
  const released = (c: TenantContext, key: FeatureFlag) =>
    release(c.tenantId, key);
  const fields = createAdaptiveFields(database, {
    audit: createAuditLog,
    refreshContext: identity.refreshContext,
    released: (c) => released(c, 'adaptive-custom-fields'),
  });
  const plain: Record<ViewReaderDomain, ViewReadAdapter> = {
    orders: {
      supportsCustomQueries: true,
      read: async (c, q, view, selectedRecordIds) => {
        const adaptive =
          view.customFilters.length > 0 ||
          view.sort?.field.startsWith('custom:') ||
          selectedRecordIds?.length;
        const native = orderListQuerySchema.parse(q);
        const v = await owners.orders.list(c, {
          ...native,
          ...(adaptive
            ? {
                adaptive: {
                  filters: view.customFilters,
                  sort: view.sort?.field.startsWith('custom:')
                    ? {
                        fieldId: view.sort.field.slice(7),
                        direction: view.sort.direction,
                      }
                    : undefined,
                  selectedRecordIds,
                },
              }
            : {}),
        });

        return { ...v, items: v.items.map((item) => ({ ...item })) };
      },
    },
    inventory: {
      read: async (c, q) => {
        const v = await owners.inventory.list(c, inventoryQuerySchema.parse(q));

        return { ...v, items: v.items.map((item) => ({ ...item })) };
      },
    },
    fulfillment: {
      read: async (c, q) => {
        const v = await owners.fulfillment.list(
          c,
          fulfillmentQuerySchema.parse(q),
        );

        return { ...v, items: v.items.map((item) => ({ ...item })) };
      },
    },
    returns: {
      read: async (c, q) => {
        const v = await owners.returns.list(c, returnQuerySchema.parse(q));

        return {
          ...v,
          warnings: sourceWarnings(v.sources),
          totalCount: v.counts.views.all,
          items: v.items.map((item) => ({ ...item })),
        };
      },
    },
    customers: {
      read: async (c, q) => {
        const v = await owners.customers.list(c, customerQuerySchema.parse(q));

        return {
          ...v,
          warnings: sourceWarnings(v.sources),
          items: v.items.map((item) => ({ ...item })),
        };
      },
    },
    products: {
      read: async (c, q) => {
        const v = await owners.products.list(c, productQuerySchema.parse(q));

        return {
          ...v,
          warnings: sourceWarnings(v.sources),
          items: v.items.map((item) => ({ ...item, id: item.skuId })),
        };
      },
    },
    decisions: {
      read: async (c, q) => {
        const v = await owners.decisions.list(c, decisionQuerySchema.parse(q));

        return {
          ...v,
          warnings: sourceWarnings(v.sources),
          asOf: new Date().toISOString(),
          items: v.items.map((item) => ({ ...item })),
        };
      },
    },
    issues: {
      read: async (c, q) => {
        const v = await owners.cases.list(c, caseQuerySchema.parse(q));

        return {
          ...v,
          asOf: new Date().toISOString(),
          items: v.items.map((item) => ({ ...item })),
        };
      },
    },
    procurement: {
      read: async (c, q) => {
        requirePermission(c, 'procurement.read');
        // The same list the Procurement page reads: built-in views as `stage`, catalog
        // conditions as `where`, with stage, attention and dates from the progress rules.
        const query = purchaseOrderListQuerySchema.parse(q);
        const list = await owners.commitments.listOrders(c, query);
        // Row actions such as a supplier follow-up need the key of one open item, which the
        // list summarizes by kind only; read the open items once when a row has any.
        const open = list.items.some((item) => item.summary.attention > 0)
          ? await owners.commitments.pending(c)
          : [];
        const requested = new Set(
          (query.where?.conditions ?? []).flatMap((condition) =>
            condition.field === 'attention' &&
            ['any_of', 'all_of'].includes(condition.op) &&
            Array.isArray(condition.value)
              ? condition.value.filter(
                  (value): value is string => typeof value === 'string',
                )
              : [],
          ),
        );
        const attentionKey = (order: (typeof list.items)[number]) => {
          const items = open
            .filter((item) => item.order.id === order.id)
            .map((item) => item.attention)
            .filter((item) =>
              (order.summary.attentionKinds ?? []).includes(item.kind),
            );

          return (
            (items.find((item) => requested.has(item.kind)) ?? items[0])?.key ??
            null
          );
        };
        const items = list.items.map((order) => ({
          id: order.id,
          reference: order.reference,
          number: order.summary.externalOrderNumber,
          supplierId: order.supplierId,
          supplierName: order.supplierName,
          status: order.status,
          stage: order.summary.stage,
          attentionKey: attentionKey(order),
          expectedDate: order.summary.expectedDate,
          confirmationDueAt: order.summary.confirmationDueAt ?? null,
          nextCheckAt: order.summary.nextCheckAt ?? null,
          nextOwner: order.summary.nextOwner,
          lines: order.lines.length,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          authority: order.authority,
          locationIds: [
            ...new Set(order.lines.flatMap((line) => line.locationId ?? [])),
          ],
          skus: [...new Set(order.lines.map((line) => line.sku))],
          value: order.summary.value ?? null,
        }));

        return {
          items,
          nextCursor: list.nextCursor,
          asOf: list.asOf,
          totalCount: list.totalCount,
        };
      },
    },
  };
  const readers = {
    orders: createAdaptiveViewReadAdapter(database, plain.orders, {
      recordType: 'order',
      columns: viewReaderKeys('orders'),
    }),
    inventory: createAdaptiveViewReadAdapter(database, plain.inventory, {
      columns: viewReaderKeys('inventory'),
    }),
    fulfillment: createAdaptiveViewReadAdapter(database, plain.fulfillment, {
      columns: viewReaderKeys('fulfillment'),
    }),
    returns: createAdaptiveViewReadAdapter(database, plain.returns, {
      columns: viewReaderKeys('returns'),
    }),
    customers: createAdaptiveViewReadAdapter(database, plain.customers, {
      recordType: 'customer',
      columns: viewReaderKeys('customers'),
    }),
    products: createAdaptiveViewReadAdapter(database, plain.products, {
      recordType: 'product',
      columns: viewReaderKeys('products'),
    }),
    procurement: createAdaptiveViewReadAdapter(database, plain.procurement, {
      recordType: 'purchase_order',
      columns: viewReaderKeys('procurement'),
    }),
    decisions: createAdaptiveViewReadAdapter(database, plain.decisions, {
      columns: viewReaderKeys('decisions'),
    }),
    issues: createAdaptiveViewReadAdapter(database, plain.issues, {
      columns: viewReaderKeys('issues'),
    }),
  };
  const followUp: ViewActionCapability = {
    kind: 'capability',
    id: 'supplier.follow-up',
    domains: ['procurement'],
    permissions: [
      'procurement.read',
      'procurement.manage',
      'messages.read',
      'messages.send',
    ],
    inputs: {
      connectionId: 'string',
      attentionKey: 'string',
      nextCheckHours: 'number',
      reason: 'string',
    },
    validateInputs: (input) => {
      z.object({
        connectionId: z.string().uuid(),
        attentionKey: z.string().min(1).max(500),
        nextCheckHours: z.number().int().min(1).max(720),
        reason: z.string().trim().min(1).max(2000),
      })
        .partial()
        .strict()
        .parse(input);
    },
    available: async (c) =>
      (await released(c, 'procurement-supplier-follow-ups'))
        ? null
        : 'Supplier follow-up drafting is not enabled for this workspace.',
    review: async (c, id, input) => {
      const connectionId = z.string().uuid().parse(input.connectionId),
        hours = z.number().int().min(1).max(720).parse(input.nextCheckHours);
      const [record, status] = await Promise.all([
        owners.commitments.order(c, id),
        owners.supplierEmail.status(c, id),
      ]);
      if (!status.mailboxes.some((m) => m.connectionId === connectionId))
        throw new IdentityError(
          409,
          'NOT_READY',
          'The selected Operations Inbox cannot send.',
        );
      const attention = record.progress.attention.find(
        (a) =>
          a.key === input.attentionKey &&
          ['confirmation_overdue', 'delivery_overdue'].includes(a.kind),
      );
      if (!attention)
        throw new IdentityError(
          409,
          'CONFLICT',
          'This overdue supplier commitment is no longer current.',
        );

      return {
        scope: `Purchase order ${record.order.reference}; ${record.supplier?.name ?? record.order.supplierName}`,
        changes: [
          {
            label: 'Supplier follow-up',
            before: null,
            after: String(input.reason),
          },
          {
            label: 'Next check after verified send',
            before: null,
            after: `${hours} hours`,
          },
        ],
        approval:
          'Creates an Operations Inbox draft. Sending requires the inbox policy and its normal approval review.',
        verification:
          'Only an independently verified send records the follow-up. A send does not establish supplier confirmation.',
        evidence: canonicalJson({
          orderRevision: record.order.revision,
          supplierRevision: record.supplier?.revision ?? 1,
          attentionKey: attention.key,
          mailbox: connectionId,
        }),
      };
    },
    propose: async (c, id, commandId, input, review) => {
      const checked = await followUp.review(c, id, input);
      if (checked.evidence !== review.evidence)
        throw new IdentityError(
          409,
          'CONFLICT',
          'The supplier evidence changed. Review again.',
        );
      const result = await owners.supplierEmail.followUp(c, id, {
        id: commandId,
        connectionId: input.connectionId,
        attentionKey: input.attentionKey,
        nextCheckAt: new Date(
          Date.now() + Number(input.nextCheckHours) * 3_600_000,
        ).toISOString(),
        reason: input.reason,
      });

      return {
        state: result.state === 'uncertain' ? 'uncertain' : 'proposed',
        reason: result.stateReason,
        proposalId: result.id,
        destination: `inbox/${result.threadId}`,
      };
    },
  };
  const actions = createAdaptiveActions({
    refreshContext: identity.refreshContext,
    released: (c) => released(c, 'adaptive-view-actions'),
    view: async (c, id) => {
      const view = await views.get(c, id);
      if (view.archived)
        throw new IdentityError(404, 'NOT_FOUND', 'View not found.');

      return view;
    },
    rows: async (c, v, ids) => {
      // Rows carry every field an action maps, keyed by catalog column ID.
      const fields = new Set([
        ...v.query.state.columns.map((column) => column.id),
        ...v.query.actions.flatMap((action) =>
          Object.values(action.inputs).flatMap((input) =>
            input.source === 'row' ? [input.field] : [],
          ),
        ),
      ]);
      const data = await views.preview(
        c,
        {
          ...v.query,
          state: {
            ...v.query.state,
            columns: [...fields].map((id) => ({ id })),
          },
        },
        undefined,
        ids,
      );

      return data.items;
    },
    rowTypes: async (c, domain) => {
      const types: Record<string, 'string' | 'number' | 'boolean'> = {};
      const numeric = new Set(['lineCount', 'orderCount', 'lines']);
      const booleans = new Set(['overdue', 'differs', 'open']);
      const scalarStrings = new Set([
        'id',
        'displayNumber',
        'status',
        'paymentStatus',
        'fulfillment',
        'placedAt',
        'dueAt',
        'comparisonState',
        'observedAt',
        'skuId',
        'sku',
        'skuKey',
        'locationId',
        'location',
        'unit',
        'kind',
        'connectionId',
        'externalId',
        'progressAt',
        'fulfillAt',
        'fulfillBy',
        'estimatedDeliveryAt',
        'displayName',
        'email',
        'phone',
        'state',
        'sourceCreatedAt',
        'sourceUpdatedAt',
        'title',
        'supplierId',
        'supplierName',
        'reference',
        'number',
        'attentionKey',
        'confirmationDueAt',
        'nextCheckAt',
        'createdAt',
        'updatedAt',
        'class',
        'severity',
        'summary',
        'detectedAt',
        'lastActivityAt',
        'domain',
        'reason',
        'why',
        'response',
        'requestedAt',
        'deadline',
        'name',
        'stage',
        'quantity',
        'activityAt',
        'expectedDate',
        'nextOwner',
        'authority',
      ]);
      const reader = viewReaderDomains.find((item) => item === domain);
      const available = reader ? Object.entries(viewReaderColumns[reader]) : [];
      types.id = 'string';
      for (const [id, column] of available) {
        if (numeric.has(column)) types[id] = 'number';
        else if (booleans.has(column)) types[id] = 'boolean';
        else if (
          scalarStrings.has(column) &&
          !(domain === 'fulfillment' && column === 'location')
        )
          types[id] = 'string';
      }
      const recordType =
        domain === 'orders'
          ? 'order'
          : domain === 'products'
            ? 'product'
            : domain === 'procurement'
              ? 'purchase_order'
              : domain === 'customers'
                ? 'customer'
                : null;
      if (
        recordType &&
        (await released(c, 'adaptive-custom-fields')) &&
        hasPermission(c, 'adaptive.fields.read')
      )
        for (const field of await fields.list(c, recordType)) {
          if (field.type === 'multi_choice') continue;
          types[`custom:${field.id}`] =
            field.type === 'number'
              ? 'number'
              : field.type === 'boolean'
                ? 'boolean'
                : 'string';
        }

      return types;
    },
    catalog: async (c) => {
      const catalog: ViewActionCapability[] = [followUp];
      if (
        !hasPermission(c, 'workflows.read') ||
        !hasPermission(c, 'workflows.triggers.manage')
      )
        return catalog;
      const versions = await createWorkflowCatalogStore(database).versions(c);
      const domains: Record<string, string> = {
        order: 'orders',
        purchase_order: 'procurement',
        sku: 'products',
        stock_position: 'inventory',
        fulfillment: 'fulfillment',
        customer: 'customers',
        issue: 'issues',
      };
      for (const version of versions) {
        if (
          version.applicability.trigger.kind !== 'manual' ||
          !domains[version.applicability.subjectKind]
        )
          continue;
        const inputFields = Object.entries(version.inputs).map(
            ([key, type]) => [`input.${key}`, type] as const,
          ),
          evidenceFields = Object.entries(version.context.fields).map(
            ([key, type]) => [`evidence.${key}`, type] as const,
          );
        if (
          [...inputFields, ...evidenceFields].some(
            ([, type]) => type === 'null',
          )
        )
          continue;
        const inputs: Record<string, 'string' | 'number' | 'boolean'> = {};
        for (const [key, type] of [...inputFields, ...evidenceFields])
          if (type !== 'null') inputs[key] = type;
        const adapter: ViewActionCapability = {
          kind: 'workflow',
          id: version.definition.id,
          version: version.version,
          domains: [domains[version.applicability.subjectKind]!],
          permissions: ['workflows.read', 'workflows.triggers.manage'],
          inputs,
          available: async (context) => {
            const detail = await owners.workflows.detail(
              context,
              version.definition.id,
            );

            return detail.summary.blockers.length
              ? detail.summary.blockers.join(' ')
              : null;
          },
          review: async (_context, id, values) => ({
            scope: `${version.definition.name}: ${id}`,
            changes: [
              {
                label: 'Workflow run',
                before: null,
                after: `${version.definition.name} ${version.version}`,
              },
              ...Object.entries(values).map(([label, value]) => ({
                label,
                before: null,
                after: String(value),
              })),
            ],
            approval:
              'Starting a run grants no action approval. Each workflow action retains its own policy and approval.',
            verification:
              'Workflow execution records independent verification for actions. Starting is not proof of resolution.',
            evidence: version.digest,
          }),
          propose: async (context, id, commandId, values, review) => {
            const current = (
              await createWorkflowCatalogStore(database).versions(
                context,
                version.definition.id,
              )
            ).find((v) => v.version === version.version);
            if (!current || current.digest !== review.evidence)
              throw new IdentityError(
                409,
                'CONFLICT',
                'This published workflow version is unavailable.',
              );
            const occurredAt = new Date().toISOString();
            const result = await owners.workflows.fire(
              context,
              version.definition.id,
              {
                version: version.version,
                reviewedDigest: version.digest,
                subject: { kind: version.applicability.subjectKind, id },
                signal: { kind: 'manual', sourceId: commandId, occurredAt },
                context: {
                  inputs: Object.fromEntries(
                    Object.entries(values)
                      .filter(([key]) => key.startsWith('input.'))
                      .map(([key, value]) => [key.slice(6), value]),
                  ),
                  evidence: {
                    kind: version.context.kind,
                    facts: Object.fromEntries(
                      Object.entries(values)
                        .filter(([key]) => key.startsWith('evidence.'))
                        .map(([key, value]) => [key.slice(9), value]),
                    ),
                    observations: [
                      {
                        id: commandId,
                        observedAt: occurredAt,
                        source: 'reviewed-workspace-input',
                      },
                    ],
                  },
                  provenance: {
                    reference: `adaptive-action:${commandId}`,
                    capturedAt: occurredAt,
                  },
                },
              },
            );

            return {
              state: 'proposed',
              reason:
                'The workflow was started. Its actions and outcome require their normal checks.',
              proposalId: result.id,
              destination: `workflows/${version.definition.id}`,
            };
          },
        };
        catalog.push(adapter);
      }

      return catalog;
    },
    receipts: createActionReceipts(database),
  });
  const viewOptions = {
    identities: createAdaptiveViewIdentities(database),
    refreshContext: identity.refreshContext,
    released: (
      c: TenantContext,
      key: 'adaptive-saved-views' | 'adaptive-view-generation',
    ) => released(c, key),
    readers,
    fields: async (c: TenantContext, domain: string) => {
      const type =
        domain === 'orders'
          ? 'order'
          : domain === 'products'
            ? 'product'
            : domain === 'procurement'
              ? 'purchase_order'
              : domain === 'suppliers'
                ? 'supplier'
                : domain === 'customers'
                  ? 'customer'
                  : null;
      if (
        !type ||
        !(await released(c, 'adaptive-custom-fields')) ||
        !hasPermission(c, 'adaptive.fields.read')
      )
        return [];

      return fields.list(c, type, true);
    },
    validateActions: actions.validate,
    copyActions: actions.copyBindings,
    validateRoles: async (c: TenantContext, roleIds: readonly string[]) => {
      const roles = new Set(await createRoleIdentityReader(database)(c));
      for (const id of roleIds)
        if (!roles.has(id))
          throw new IdentityError(
            422,
            'VALIDATION_ERROR',
            'Choose an existing workspace role.',
          );
    },
    trace: (c: TenantContext) => ({
      requestId: c.requestId,
      traceId: createHash('sha256')
        .update(c.requestId)
        .digest('hex')
        .slice(0, 32),
      spanId: createHash('sha256')
        .update(`view:${c.requestId}`)
        .digest('hex')
        .slice(0, 16),
    }),
    ...(options.model && options.modelAvailable
      ? { model: options.model }
      : {}),
  };
  const views: AdaptiveViews = createAdaptiveViews(database, viewOptions);
  const packageStore = createPackageStore(database, {
    install: async (db, c, d, prior) => {
      const f = createAdaptiveFields(db, {
        audit: createAuditLog,
        refreshContext: identity.refreshContext,
        released: (ctx) => released(ctx, 'adaptive-custom-fields'),
      });
      const v = createAdaptiveViews(db, viewOptions);
      const resources: PackageResource[] = prior ? [...prior.resources] : [];
      for (const field of d.fields) {
        const owned = resources.find(
          (r) => r.kind === 'field' && r.key === field.key,
        );
        if (owned) {
          if (prior?.removed) {
            const existing = (
              await f.list(c, field.definition.recordType, true)
            ).find((candidate) => candidate.id === owned.id);
            if (existing?.archived)
              await f.restore(c, existing.id, existing.revision);
          }
          continue;
        }
        const found = (await f.list(c, field.definition.recordType, true)).find(
          (candidate) => candidate.key === field.definition.key,
        );
        if (found)
          throw new IdentityError(
            409,
            'CONFLICT',
            'A package field key already belongs to another definition.',
          );
        const made = await f.create(c, {
          ...field.definition,
          commandId: uuid(`package:${c.tenantId}:${d.id}:field:${field.key}`),
        });
        resources.push({ kind: 'field', key: field.key, id: made.id });
      }
      for (const view of d.views) {
        const owned = resources.find(
          (r) => r.kind === 'view' && r.key === view.key,
        );
        if (owned) {
          if (prior?.removed) {
            const existing = await v.get(c, owned.id);
            if (existing.archived)
              await v.restore(c, existing.id, existing.revision);
          }
          continue;
        }
        const made = await v.create(
          c,
          adaptiveViewInputSchema.parse({
            ...z.record(z.string(), z.unknown()).parse(view.definition),
            commandId: uuid(`package:${c.tenantId}:${d.id}:view:${view.key}`),
          }),
        );
        resources.push({ kind: 'view', key: view.key, id: made.id });
      }
      for (const workflow of d.workflows) {
        const owned = resources.find(
          (r) => r.kind === 'workflow' && r.key === workflow.key,
        );
        if (owned) {
          if (prior?.removed)
            await createPackageWorkflowArchive(db).restore(c, d.id, owned.id);
          continue;
        }
        const definition = z
          .record(z.string(), z.unknown())
          .parse(workflow.definition);
        const compiled = compileProcessWorkflow({
          ...definition,
          provenance: {
            kind: 'native',
            reference: `package:${d.id}:${d.version}`,
            authoredBy: 'Luma',
            evidenceRefs: [`operational-package:${d.id}:${d.version}`],
          },
        });
        const existing = await createWorkflowCatalogStore(db).versions(
          c,
          compiled.definition.id,
        );
        if (existing.length)
          throw new IdentityError(
            409,
            'CONFLICT',
            'The package workflow already belongs to another installation.',
          );
        await createWorkflowCatalogStore(db).publish(c, compiled);
        resources.push({
          kind: 'workflow',
          key: workflow.key,
          id: compiled.definition.id,
        });
      }

      return resources;
    },
    remove: async (db, c, i) => {
      const f = createAdaptiveFields(db, {
        audit: createAuditLog,
        refreshContext: identity.refreshContext,
        released: (ctx) => released(ctx, 'adaptive-custom-fields'),
      });
      const v = createAdaptiveViews(db, viewOptions);
      for (const resource of i.resources) {
        if (resource.kind === 'field') {
          for (const type of [
            'order',
            'product',
            'supplier',
            'purchase_order',
          ] as const) {
            const found = (await f.list(c, type, true)).find(
              (field) => field.id === resource.id,
            );
            if (found && !found.archived)
              await f.archive(c, found.id, found.revision);
          }
        } else if (resource.kind === 'view') {
          const found = await v.get(c, resource.id);
          if (!found.archived) await v.archive(c, found.id, found.revision);
        } else {
          const detail = await owners.workflows.detail(c, resource.id);
          if (detail.activations.some((a) => a.active))
            throw new IdentityError(
              409,
              'CONFLICT',
              'Revoke the package workflow through its normal review before removing this package.',
            );
          await createPackageWorkflowArchive(db).archive(
            c,
            i.packageId,
            resource.id,
          );
        }
      }
    },
  });
  const packages = createAdaptivePackages({
    definitions: [purchasingPackage, purchasingPackageNext],
    store: packageStore,
    refreshContext: identity.refreshContext,
    released: (c) => released(c, 'adaptive-operational-packages'),
    configure: async (c, d, config) => {
      const configured = configurePurchasingPackage(d, config);
      for (const field of configured.fields) {
        if (
          !isPermission(field.definition.readPermission) ||
          !isPermission(field.definition.writePermission) ||
          !hasPermission(c, field.definition.readPermission) ||
          !hasPermission(c, field.definition.writePermission)
        )
          throw new IdentityError(
            403,
            'FORBIDDEN',
            'Your role cannot grant these field permissions.',
          );
      }
      for (const view of configured.views) {
        const checked = adaptiveViewInputSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(view.definition),
          commandId: uuid(`preview:${c.tenantId}:${d.id}:${view.key}`),
        });
        await actions.validate(c, upgradeAdaptiveViewQuery(checked.query));
      }
      for (const workflow of configured.workflows)
        compileProcessWorkflow({
          ...z.record(z.string(), z.unknown()).parse(workflow.definition),
          provenance: {
            kind: 'native',
            reference: `package:${d.id}:${d.version}`,
            authoredBy: 'Luma',
            evidenceRefs: [`operational-package:${d.id}:${d.version}`],
          },
        });

      return configured;
    },
    missing: async (c, _d, config) => {
      const missing: string[] = [];
      for (const key of [
        'adaptive-custom-fields',
        'adaptive-saved-views',
        'adaptive-view-actions',
      ] as const)
        if (!(await released(c, key))) missing.push(`${key} is not enabled.`);
      const reason = await followUp.available(c);
      if (reason) missing.push(reason);
      const list = await options.database.transaction(c.tenantId, (tx) =>
        tx.query<{ document: unknown }>(
          'SELECT document FROM connector_installations WHERE tenant_id=$1 AND id=$2',
          [c.tenantId, config.parameters.mailboxId],
        ),
      );
      const mailbox = list.rows[0]?.document;
      const ready = z
        .object({ status: z.literal('active'), granted: z.array(z.string()) })
        .safeParse(mailbox);
      if (!ready.success || !ready.data.granted.includes('messages.send'))
        missing.push(
          'Install an active Operations Inbox with permission to send.',
        );

      return missing;
    },
  });
  const availability = async (c: TenantContext) => {
    c = await identity.refreshContext(c);
    const [fields, views, generation, actions, packages] = await Promise.all(
      [
        'adaptive-custom-fields',
        'adaptive-saved-views',
        'adaptive-view-generation',
        'adaptive-view-actions',
        'adaptive-operational-packages',
      ].map((flag) => released(c, flag as FeatureFlag)),
    );

    return {
      fields: !!fields,
      views: !!views,
      generation: !!views && !!generation && !!options.modelAvailable,
      actions: !!views && !!actions,
      packages: !!packages,
    };
  };

  const collections = createCollectionStates(database, {
    refreshContext: identity.refreshContext,
  });

  const exports = createViewExportsService({
    views,
    refreshContext: identity.refreshContext,
    audit: createAuditLog(database),
  });

  return {
    fields,
    views,
    actions,
    packages,
    collections,
    exports,
    availability,
  };
}
