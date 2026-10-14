import '@luma/identity/http';

import {
  apiContract,
  type CollectionCatalog,
  type CollectionGranularity,
  collectionGroupIssue,
  type CollectionWhere,
  collectionWhereIssues,
  procurementCatalog,
  suppliersCatalog,
} from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { SupplierCommitments } from '../application/commitments.js';
import type { createIncomingStock } from '../application/incoming.js';
import type { ProcurementService } from '../application/procurement.js';
import type { PurchasingService } from '../application/purchasing.js';
import type { PurchasingOutcomes } from '../application/purchasing-outcomes.js';
import type { SupplierTermsService } from '../application/supplier-terms.js';

function badRequest(message: string) {
  return Object.assign(
    new Error(message.endsWith('.') ? message : `${message}.`),
    { statusCode: 400, expose: true },
  );
}

/**
 * The first invalid condition against `catalog` as a readable message, or null. Custom-field
 * conditions (`custom:<id>`) are checked by the list against the workspace's live definitions,
 * so they are skipped here and keep their positions in messages.
 */
function whereIssue(catalog: CollectionCatalog, where?: CollectionWhere) {
  const checked = (where?.conditions ?? [])
    .map((condition, index) => ({ condition, index }))
    .filter(({ condition }) => !condition.field.startsWith('custom:'));
  const found = checked.length
    ? collectionWhereIssues(catalog, {
        match: where?.match ?? 'all',
        conditions: checked.map(({ condition }) => condition),
      })[0]
    : undefined;
  if (!found) return null;
  const index = found.index === null ? 0 : (checked[found.index]?.index ?? 0);

  return `Condition ${index + 1}: ${found.message}.`;
}

/**
 * Checks purchase-order conditions and grouping against the procurement catalog. Throws a 400
 * error naming the first invalid condition, for a group key without a grouping, and for a page
 * link of a grouped read without its group key.
 */
export function validatePurchaseOrderListQuery(query: {
  where?: CollectionWhere | undefined;
  group?:
    | { field: string; granularity?: CollectionGranularity | undefined }
    | undefined;
  groupKey?: string | number | boolean | null | undefined;
  cursor?: string | undefined;
}) {
  const message =
    whereIssue(procurementCatalog, query.where) ??
    (query.group
      ? (collectionGroupIssue(
          procurementCatalog,
          query.group.field,
          query.group.granularity,
        ) ??
        (query.groupKey === undefined && query.cursor
          ? 'Use a group’s page link together with its group key'
          : null))
      : query.groupKey !== undefined
        ? 'Choose a grouping to read one group'
        : null);
  if (message) throw badRequest(message);
}

/** Checks supplier conditions against the suppliers catalog; throws a 400 error otherwise. */
export function validateSupplierListQuery(query: {
  where?: CollectionWhere | undefined;
}) {
  const message = whereIssue(suppliersCatalog, query.where);
  if (message) throw badRequest(message);
}

/** Registers tenant-authenticated procurement reads and permission-gated writes. */
export function procurementRoutes(
  service?: ProcurementService,
  commitments?: SupplierCommitments,
  terms?: SupplierTermsService,
  purchasing?: PurchasingService,
  outcomes?: PurchasingOutcomes,
  incoming?: ReturnType<typeof createIncomingStock>,
) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service || !commitments)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Procurement is unavailable. Try again later.',
      );

    return { context: request.tenantContext, service, commitments };
  }

  const os = implement(apiContract.procurement).$context<HttpContext>();

  function purchases(request: FastifyRequest) {
    const s = use(request);
    if (!purchasing)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Purchasing is unavailable.',
      );

    return { context: s.context, service: purchasing };
  }

  return os.router({
    purchasingOutcomes: os.purchasingOutcomes.handler(
      async ({ context: { request } }) => {
        const s = use(request);
        if (!outcomes)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Purchasing outcomes are unavailable.',
          );

        return outcomes.read(s.context);
      },
    ),
    purchasingIgnore: os.purchasingIgnore.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);
        if (!outcomes)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Purchasing outcomes are unavailable.',
          );

        return outcomes.ignore(s.context, body);
      },
    ),
    incomingStock: os.incomingStock.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);
        if (!incoming)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Incoming stock is unavailable.',
          );

        return await incoming.read(s.context, body);
      },
    ),
    purchasingOverview: os.purchasingOverview.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = purchases(request);

        return s.service.overview(s.context, query.demandPeriodDays);
      },
    ),
    purchasingSettings: os.purchasingSettings.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = purchases(request);

        return s.service.settings(s.context, body);
      },
    ),
    purchasingPlans: os.purchasingPlans.handler(
      async ({ context: { request } }) => {
        const s = purchases(request);

        return s.service.plans(s.context);
      },
    ),
    purchasingPlan: os.purchasingPlan.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = purchases(request);

        return s.service.propose(s.context, body);
      },
    ),
    purchasingDecision: os.purchasingDecision.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = purchases(request);

        return s.service.decide(s.context, params.planId, body);
      },
    ),
    purchasingExecute: os.purchasingExecute.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = purchases(request);

        return s.service.execute(s.context, params.planId);
      },
    ),
    purchasingReconcile: os.purchasingReconcile.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = purchases(request);

        return s.service.reconcile(s.context, params.planId);
      },
    ),
    supplierTerms: os.supplierTerms.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = use(request);
        if (!terms)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Purchasing terms are unavailable.',
          );

        return terms.list(s.context, query);
      },
    ),
    saveSupplierTerms: os.saveSupplierTerms.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);
        if (!terms)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Purchasing terms are unavailable.',
          );

        return terms.save(s.context, body);
      },
    ),
    suppliers: os.suppliers.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = use(request);
        validateSupplierListQuery(query);
        // A separate read: the order progress rules decide which confirmations are overdue.
        const confirmationOverdue = query.where?.conditions.some(
          (condition) => condition.field === 'confirmationOverdue',
        )
          ? await s.commitments.confirmationOverdueSuppliers(s.context)
          : undefined;

        return await s.service.listSuppliers(s.context, query, {
          confirmationOverdue,
        });
      },
    ),
    orders: os.orders.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = use(request);
        validatePurchaseOrderListQuery(query);

        return await s.commitments.listOrders(s.context, query);
      },
    ),
    createSupplier: os.createSupplier.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return await s.service.createSupplier(s.context, body);
      },
    ),
    createOrder: os.createOrder.handler(
      async ({ context: { request }, input: { body } }) => {
        const s = use(request);

        return await s.service.createOrder(s.context, body);
      },
    ),
    detail: os.detail.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.detail(s.context, params.purchaseOrderId);
      },
    ),
    supplier: os.supplier.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.supplier(s.context, params.supplierId);
      },
    ),
    linkSupplier: os.linkSupplier.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.linkSupplier(
          s.context,
          params.supplierId,
          body,
        );
      },
    ),
    purchasingConnections: os.purchasingConnections.handler(
      async ({ context: { request } }) => {
        const s = use(request);

        return await s.commitments.connections(s.context);
      },
    ),
    purchasingSuppliers: os.purchasingSuppliers.handler(
      async ({ context: { request }, input: { params, query } }) => {
        const s = use(request);

        return await s.commitments.purchasingSuppliers(
          s.context,
          params.connectionId,
          query.cursor,
        );
      },
    ),
    progress: os.progress.handler(async ({ context: { request } }) => {
      const s = use(request);

      return { items: await s.commitments.summaries(s.context) };
    }),
    record: os.record.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.order(s.context, params.purchaseOrderId);
      },
    ),
    refresh: os.refresh.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.refresh(s.context, params.purchaseOrderId);
      },
    ),
    requestSubmission: os.requestSubmission.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.requestSubmission(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
    decideSubmission: os.decideSubmission.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.decideSubmission(
          s.context,
          params.submissionId,
          body,
        );
      },
    ),
    sendSubmission: os.sendSubmission.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.sendSubmission(
          s.context,
          params.submissionId,
        );
      },
    ),
    checkSubmission: os.checkSubmission.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.checkSubmission(
          s.context,
          params.submissionId,
        );
      },
    ),
    recordMessage: os.recordMessage.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.recordMessage(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
    readMessage: os.readMessage.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.extractAgain(
          s.context,
          params.communicationId,
        );
      },
    ),
    removeMessageText: os.removeMessageText.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.commitments.removeMessageText(
          s.context,
          params.communicationId,
        );
      },
    ),
    recordCommitment: os.recordCommitment.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.recordCommitment(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
    recordReceipt: os.recordReceipt.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.recordReceipt(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
    reviewCommitment: os.reviewCommitment.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.reviewCommitment(
          s.context,
          params.commitmentId,
          body,
        );
      },
    ),
    respond: os.respond.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.commitments.respond(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
    transition: os.transition.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.transition(
          s.context,
          params.purchaseOrderId,
          body,
        );
      },
    ),
  });
}
