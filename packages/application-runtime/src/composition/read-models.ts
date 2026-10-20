import type { AppRegistry } from '@luma/app-host';
import {
  createConnectionCoverage,
  type createOrderSourceVisibility,
  type createSourceAuthority,
} from '@luma/connections/composition';
import {
  caseTimelineQuery,
  createCaseMetricReader,
  createOrderAttentionBoundaryReader,
  orderAttentionForOrders,
  orderAttentionQuery,
} from '@luma/exceptions/composition';
import {
  admittedActionCitations,
  admittedActionRecords,
} from '@luma/execution/composition';
import type { IdentityService, Permission } from '@luma/identity';
import {
  ledgerEvidence,
  purchaseReceiptCitations,
  purchaseReceiptEvidence,
  stockReadEvidence,
} from '@luma/inventory/composition';
import {
  messageEvidence,
  replyCitations,
  replyEvidence,
} from '@luma/messaging/composition';
import {
  createOrderMetricReader,
  orderReadEvidence,
  orderStateQueries,
  returnCitations,
  returnEvidence,
  type ReturnEvidenceKind,
} from '@luma/orders/composition';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { forbidden } from '@luma/platform';
import {
  type createProcurement,
  createProcurementMetricReader,
  createStockRiskReader,
  purchaseOrderCitations,
  purchaseOrderEvidence,
  purchaseOrderMessageRefs,
  purchaseOrderStockRefs,
  purchasingPlanCitations,
  purchasingPlanEvidence,
  replenishmentRunCitations,
  replenishmentRunEvidence,
  type SupplierCommitments,
} from '@luma/procurement/composition';
import type {
  EvidenceAccess,
  EvidenceOwners,
  EvidenceSubjectOwner,
  StoredEvidence,
} from '@luma/read-models';
import {
  capabilityReadPermission,
  createChangeFeed,
  createCustomerWorkspace,
  createEvidenceReader,
  createFulfillmentWorkspace,
  createInsights,
  createInventoryWorkspace,
  createOperationalMetrics,
  createOperationalSummary,
  createOrderWorkspace,
  createProcurementContext,
  createProductWorkspace,
  createRecordExplorer,
  createReturnWorkspace,
} from '@luma/read-models/composition';
import {
  caseCitations,
  caseRecords,
  createActivityStore,
  createResolutionMetricReader,
} from '@luma/resolution/composition';

import type { createTenantFeatureRelease } from './feature-release.js';

/** The read-only workspace views, by the HTTP area that serves them. */
export interface ReadModelServices {
  changes: ReturnType<typeof createChangeFeed>;
  customers: ReturnType<typeof createCustomerWorkspace>;
  evidence: ReturnType<typeof createEvidenceReader>;
  fulfillment: ReturnType<typeof createFulfillmentWorkspace>;
  insights: ReturnType<typeof createInsights>;
  inventory: ReturnType<typeof createInventoryWorkspace>;
  metrics: ReturnType<typeof createOperationalMetrics>;
  operationalSummary: ReturnType<typeof createOperationalSummary>;
  orders: ReturnType<typeof createOrderWorkspace>;
  procurementContext: ReturnType<typeof createProcurementContext>;
  products: ReturnType<typeof createProductWorkspace>;
  records: ReturnType<typeof createRecordExplorer>;
  returns: ReturnType<typeof createReturnWorkspace>;
}

/**
 * Keeps evidence another area guards from a reader without that area's read permission: each
 * item becomes `restricted`, naming the permission, so the reference is not silently dropped.
 */
function guarded(
  permission: Permission,
  access: EvidenceAccess,
  found: readonly StoredEvidence[],
): StoredEvidence[] {
  return access.can(permission)
    ? [...found]
    : found.map((evidence) => ({
        kind: 'restricted',
        id: evidence.id,
        permission,
      }));
}

/**
 * The provider reads purchasing plans cite among `cited`: stock positions and native ledger
 * balances for inventory readers, and order demand for order readers.
 */
async function planInputs(
  tx: SqlTransaction,
  tenantId: string,
  cited: string[],
  access: EvidenceAccess,
): Promise<StoredEvidence[]> {
  if (!cited.length) return [];

  return [
    ...guarded('inventory.read', access, [
      ...(await stockReadEvidence(tx, tenantId, cited)),
      ...(await ledgerEvidence(tx, tenantId, cited)),
    ]),
    ...guarded(
      'orders.read',
      access,
      await orderReadEvidence(tx, tenantId, cited),
    ),
  ];
}

/**
 * The owner that reports what each kind of subject cites and finds its stored evidence. Reads
 * and receipts each carry the retention start of the table their owner began storing them in;
 * messages, inventory and order snapshots and ledger records were always stored, so their reads
 * have none. A case's and an app decision's provider evidence belongs to the apps that made the
 * writes. Evidence of another area is `restricted` for readers without its read permission.
 */
export function createEvidenceOwners(
  apps: ReturnType<AppRegistry['evidenceSources']>,
): EvidenceOwners {
  const returnRecord = (kind: ReturnEvidenceKind): EvidenceSubjectOwner => ({
    permission: 'returns.read',
    retention: { read: 'return_reads', write_receipt: 'write_receipts' },
    citations: (tx, tenantId, id) => returnCitations(tx, tenantId, kind, id),
    lookup: (tx, tenantId, id, refs) =>
      returnEvidence(tx, tenantId, kind, id, refs),
  });
  const appEvidence = async (
    tx: SqlTransaction,
    tenantId: string,
    cited: string[],
  ) => {
    const found: StoredEvidence[] = [];
    if (cited.length)
      for (const app of apps)
        found.push(...(await app.read(tx, tenantId, cited)));

    return found;
  };

  return {
    app_decision: {
      // The change's area decides; `citations` checks it once the proposal is read.
      permission: null,
      retention: { read: null, write_receipt: 'write_receipts' },
      async citations(tx, tenantId, id, access) {
        const action = await admittedActionCitations(tx, tenantId, id);
        if (!action) return null;
        const permission = capabilityReadPermission(action.capability);
        if (!permission || !access.can(permission))
          throw forbidden('You do not have access to this evidence');

        return { actionIds: action.actionIds, citations: action.citations };
      },
      async lookup(tx, tenantId, id, refs) {
        return [
          ...(await admittedActionRecords(tx, tenantId, id, refs.uuids)),
          ...(await appEvidence(tx, tenantId, refs.cited)),
        ];
      },
    },
    case: {
      permission: 'issues.read',
      retention: { read: null, write_receipt: null },
      citations: caseCitations,
      async lookup(tx, tenantId, id, refs) {
        return [
          ...(await caseRecords(tx, tenantId, id, refs)),
          ...(await appEvidence(tx, tenantId, refs.cited)),
        ];
      },
    },
    native_receipt: {
      permission: 'inventory.read',
      retention: { read: null, write_receipt: null },
      async citations(tx, tenantId, id) {
        const receipt = await purchaseReceiptCitations(tx, tenantId, id);

        return receipt ? { actionIds: [], citations: receipt.citations } : null;
      },
      async lookup(tx, tenantId, id, refs, access) {
        const receipt = await purchaseReceiptCitations(tx, tenantId, id);
        if (!receipt) return [];
        // The supplier commitments the receipt books are procurement's records.
        const cited = new Set(receipt.citations.map((c) => c.ref));
        const commitments = (
          await purchaseOrderEvidence(tx, tenantId, receipt.purchaseOrderId, {
            all: [],
            uuids: refs.uuids.filter((ref) => cited.has(ref)),
          })
        ).filter(
          (evidence) =>
            evidence.kind === 'luma_record' && evidence.record === 'commitment',
        );

        return [
          ...(await purchaseReceiptEvidence(
            tx,
            tenantId,
            { reviewId: id },
            refs.uuids,
          )),
          ...guarded('procurement.read', access, commitments),
        ];
      },
    },
    purchase_order: {
      permission: 'procurement.read',
      retention: { read: 'procurement_reads', write_receipt: 'write_receipts' },
      citations: (tx, tenantId, id) => purchaseOrderCitations(tx, tenantId, id),
      async lookup(tx, tenantId, id, requested, access) {
        const stock = access.can('inventory.read');
        // Stock booking proof of the order's receipts is the inventory area's evidence: without
        // inventory access it is listed as restricted, never resolved or left out.
        const bookings = new Set(
          stock
            ? []
            : await purchaseOrderStockRefs(tx, tenantId, id, requested.uuids),
        );
        const open = (ref: string) => !bookings.has(ref);
        const refs = {
          all: requested.all.filter(open),
          uuids: requested.uuids.filter(open),
          cited: requested.cited.filter(open),
        };
        const messages = await purchaseOrderMessageRefs(
          tx,
          tenantId,
          id,
          refs.uuids,
        );

        return [
          ...[...bookings].map((ref): StoredEvidence => ({
            kind: 'restricted',
            id: ref,
            permission: 'inventory.read',
          })),
          ...(await purchaseOrderEvidence(tx, tenantId, id, refs, { stock })),
          ...(stock ? await appEvidence(tx, tenantId, refs.cited) : []),
          ...(await planInputs(tx, tenantId, refs.cited, access)),
          // Native receipt reviews and the ledger entries that booked them.
          ...guarded(
            'inventory.read',
            access,
            await purchaseReceiptEvidence(
              tx,
              tenantId,
              { purchaseOrderId: id },
              refs.uuids,
            ),
          ),
          // The order emails its email submissions sent.
          ...(access.can('messages.read')
            ? await messageEvidence(tx, tenantId, messages)
            : messages.map((message): StoredEvidence => ({
                kind: 'restricted',
                id: message,
                permission: 'messages.read',
              }))),
        ];
      },
    },
    purchasing_plan: {
      permission: 'procurement.read',
      retention: { read: null, write_receipt: 'write_receipts' },
      citations: purchasingPlanCitations,
      async lookup(tx, tenantId, id, refs, access) {
        return [
          ...(await purchasingPlanEvidence(tx, tenantId, id, refs)),
          ...(await planInputs(tx, tenantId, refs.cited, access)),
        ];
      },
    },
    replenishment_run: {
      permission: 'procurement.read',
      // Stock and order snapshots were always stored, and the draft's receipt is the Luma order
      // it created, so nothing the run cites predates storage.
      retention: { read: null, write_receipt: null },
      citations: replenishmentRunCitations,
      async lookup(tx, tenantId, id, refs, access) {
        return [
          ...(await replenishmentRunEvidence(tx, tenantId, id, refs)),
          // The stock read the proposal rests on and the order reads behind its demand.
          ...(await planInputs(tx, tenantId, refs.cited, access)),
        ];
      },
    },
    reply: {
      permission: 'messages.read',
      retention: { read: null, write_receipt: 'write_receipts' },
      citations: replyCitations,
      lookup: replyEvidence,
    },
    return_creation: returnRecord('creation'),
    return_exchange: returnRecord('exchange'),
    return_exchange_step: returnRecord('exchange_step'),
    return_settlement: returnRecord('settlement'),
    return_wait: returnRecord('wait'),
  };
}

/**
 * Builds the read-only workspace views that read across owners' tables. They don't write and
 * hold no state, so any runtime can compose them after the owners they read.
 */
export function createReadModelServices(options: {
  database: TenantDatabase;
  identity: IdentityService;
  authority: (
    scoped: TenantDatabase,
  ) => ReturnType<typeof createSourceAuthority>;
  hiddenOrderSources: ReturnType<typeof createOrderSourceVisibility>;
  /** The permission a person needs to request a provider write through an app. */
  actionPermission?: (appId: string, capability: string) => string | null;
  commitments: SupplierCommitments;
  /** Installed apps' readers of the evidence they store for their provider writes. */
  evidenceSources?: ReturnType<AppRegistry['evidenceSources']>;
  procurement: ReturnType<typeof createProcurement>;
  release: ReturnType<typeof createTenantFeatureRelease>;
}): ReadModelServices {
  const { database, identity, hiddenOrderSources } = options;
  const orderQueries = {
    state: orderStateQueries,
    attention: orderAttentionQuery,
    attentionFor: orderAttentionForOrders,
  };
  const orders = createOrderWorkspace(
    database,
    orderQueries,
    createActivityStore,
    identity.refreshContext,
    options.authority,
    undefined,
    hiddenOrderSources,
    options.actionPermission,
  );
  const fulfillment = createFulfillmentWorkspace(
    database,
    orderQueries,
    createActivityStore,
    identity.refreshContext,
  );
  const insights = createInsights(database, {
    orders: orderQueries,
    cases: caseTimelineQuery,
    stock: createStockRiskReader,
    procurement: async (context) => {
      const [summaries, { items }] = await Promise.all([
        options.commitments.summaries(context),
        options.procurement.orders(context),
      ]);
      const orders = new Map(items.map((order) => [order.id, order]));

      // Orders created between the two reads are left for the next refresh.
      return summaries.flatMap((summary) => {
        const order = orders.get(summary.id);

        return order
          ? [
              {
                id: summary.id,
                reference: order.reference,
                supplierName: order.supplierName,
                stage: summary.stage,
                expectedDate: summary.expectedDate,
                overdue: summary.overdue,
                attention: summary.attention,
                nextOwner: summary.nextOwner,
                createdAt: order.createdAt,
              },
            ]
          : [];
      });
    },
    refreshContext: identity.refreshContext,
  });

  return {
    changes: createChangeFeed(database),
    customers: createCustomerWorkspace(database),
    evidence: createEvidenceReader(
      database,
      createEvidenceOwners(options.evidenceSources ?? []),
    ),
    fulfillment,
    insights,
    inventory: createInventoryWorkspace(database),
    metrics: createOperationalMetrics(database, {
      orders: (db) =>
        createOrderMetricReader(db, orderAttentionQuery, hiddenOrderSources),
      attentionBoundary: createOrderAttentionBoundaryReader,
      coverage: createConnectionCoverage,
    }),
    operationalSummary: createOperationalSummary(database, {
      resolutionInsightsEnabled: (tenantId) =>
        options.release(tenantId, 'resolution-insights'),
      cases: createCaseMetricReader,
      resolution: createResolutionMetricReader,
      procurement: createProcurementMetricReader,
      coverage: createConnectionCoverage,
    }),
    orders,
    procurementContext: createProcurementContext(database),
    products: createProductWorkspace(database),
    records: createRecordExplorer(database, hiddenOrderSources),
    returns: createReturnWorkspace(database),
  };
}
