import {
  type CollectionCondition,
  type CollectionGroup,
  type CollectionViewState,
  type CommitmentInput,
  type FollowUpInput,
  type MessageInput,
  orderStageSchema,
  type PurchaseOrderInput,
  type PurchaseOrderListQuery,
  purchaseOrderSortSchema,
  type SupplierInput,
  type SupplierLinkInput,
  type SupplierListQuery,
  supplierSortSchema,
  type TransitionInput,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { collectionSearchShape, groupOf } from '../../kit/collections/state';
import { ApiError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

/** A rejected procurement request, with the server's explanation when it sent one. */
export class ProcurementError extends ApiError {
  constructor(
    status: number,
    readonly feedback: string,
    body?: unknown,
  ) {
    super(status, body);
  }
}

/** Creates a procurement client that preserves known rejection statuses and server feedback. */
export function createProcurementClient() {
  return createWebApiClient(
    undefined,
    (status, body) =>
      new ProcurementError(
        status,
        typeof body === 'object' && body !== null && 'message' in body
          ? String(body.message)
          : m.procurement_error_unavailable(),
        body,
      ),
  );
}
const client = createProcurementClient();
const api = client.procurement;
const contextApi = client.procurementContext;

const purchaseOrderStatuses = ['draft', 'open', 'closed', 'cancelled'] as const;

/** Returns the private cache prefix for procurement in this workspace. */
export const procurementKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'procurement'] as const;

const purchasingPeriods = [7, 30, 60, 90, 180] as const;

/** The lists of the procurement page; purchase orders are the default. */
const procurementTabs = ['orders', 'suppliers', 'purchasing'] as const;

type ProcurementTab = (typeof procurementTabs)[number];

/** Built-in purchase-order views that the list reads through its `stage` parameter. */
const stageSegments = ['attention', 'awaiting_confirmation', 'draft'] as const;

/**
 * URL state of the procurement page: the tab, the shared list keys of the purchase-order or
 * supplier list (view, conditions, sort, grouping, display, search and paging) and the
 * purchasing period. `stage`, `status` and a tab name in `view` come from links made before
 * configurable views; the route turns them into the tab, a built-in view or conditions.
 */
export const procurementSearch = z.object({
  ...collectionSearchShape,
  tab: z.enum(procurementTabs).optional().catch(undefined),
  /** The purchase order open in the preview pane. */
  item: z.uuid().optional().catch(undefined),
  q: z
    .string()
    .trim()
    .max(200)
    .transform((value) => value || undefined)
    .optional()
    .catch(undefined),
  demandPeriodDays: z.coerce
    .number()
    .refine((days) => purchasingPeriods.some((period) => period === days))
    .optional()
    .catch(undefined),
  stage: z
    .union([orderStageSchema, z.literal('attention')])
    .optional()
    .catch(undefined),
  status: z.enum(purchaseOrderStatuses).optional().catch(undefined),
});

export type ProcurementSearch = z.infer<typeof procurementSearch>;

export const procurementPageSize = 50;

/** Rows each group shows before "Show more", and the size of each further page. */
const procurementGroupPageSize = 10;

/** The list a URL opens: its tab, or purchase orders. */
export function procurementTab(search: ProcurementSearch): ProcurementTab {
  return search.tab ?? 'orders';
}

const isTab = (value: string | undefined): value is ProcurementTab =>
  procurementTabs.some((tab) => tab === value);

/** Whether the URL still uses keys of links from before configurable views. */
export function hasLegacyProcurementKeys(search: ProcurementSearch) {
  return (
    isTab(search.view) ||
    search.stage !== undefined ||
    search.status !== undefined
  );
}

/**
 * Rewrites keys of older links: a tab name in `view` becomes `tab`, a stage with a built-in
 * view opens that view, and other stages and statuses become conditions that select the same
 * orders. Starts from the first page, because a cursor binds the filters it was read with.
 */
export function withoutLegacyProcurementKeys(
  search: ProcurementSearch,
): ProcurementSearch {
  const next: ProcurementSearch = { ...search };
  delete next.stage;
  delete next.status;
  delete next.cursor;
  delete next.page;
  if (isTab(search.view)) {
    delete next.view;
    if (search.view !== 'orders') next.tab = search.view;
  }
  const conditions: CollectionCondition[] = [];
  const segment = stageSegments.find((stage) => stage === search.stage);
  if (segment && !next.view) next.view = segment;
  else if (search.stage === 'attention')
    conditions.push({ field: 'attention', op: 'not_empty' });
  else if (search.stage)
    conditions.push({ field: 'stage', op: 'any_of', value: [search.stage] });
  if (search.status)
    conditions.push({ field: 'status', op: 'any_of', value: [search.status] });

  return conditions.length
    ? {
        ...next,
        where: {
          match: 'all',
          conditions: [
            ...(next.where?.match === 'any' && next.where.conditions.length > 1
              ? []
              : (next.where?.conditions ?? [])),
            ...conditions,
          ].slice(0, 20),
        },
      }
    : next;
}

/** Whether the URL says what to show, so the page must not restore the remembered view. */
export function namesListState(search: ProcurementSearch) {
  return Boolean(
    search.q ||
    search.cursor ||
    search.page ||
    search.item ||
    search.tab === 'purchasing',
  );
}

const orderSorts = new Set<string>(purchaseOrderSortSchema.options);

/** Whether a sort names a custom field; the server checks that it exists and is readable. */
const customSort = (field: string | undefined): field is `custom:${string}` =>
  !!field && /^custom:[0-9a-f-]{36}$/.test(field);

/**
 * Builds the purchase-order request for a view: its built-in view as `stage`, conditions (sent
 * only when there are any), sort (a catalog or custom field) and grouping, with search text
 * and the page cursor. Grouped reads return each group's first rows and take no page cursor;
 * `group` reads one group's next page instead. Calendar conditions follow `timeZone`, the
 * workspace's time zone.
 */
export function purchaseOrderListQuery(
  state: CollectionViewState,
  search: Pick<ProcurementSearch, 'q' | 'cursor'>,
  timeZone: string,
  group?: { key: CollectionGroup['key']; cursor: string },
): PurchaseOrderListQuery {
  const grouping = groupOf(state);
  const field = state.sort?.field;
  const stage = stageSegments.find((segment) => segment === state.segment);

  return {
    q: search.q?.trim() ?? '',
    ...(stage ? { stage } : {}),
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort:
      field && orderSorts.has(field)
        ? (field as PurchaseOrderListQuery['sort'])
        : customSort(field)
          ? field
          : 'created',
    direction: state.sort?.direction ?? 'desc',
    timeZone,
    count: 'exact',
    ...(grouping
      ? group
        ? {
            group: grouping,
            groupKey: JSON.stringify(group.key),
            cursor: group.cursor,
            limit: procurementPageSize,
          }
        : { group: grouping, groupLimit: procurementGroupPageSize }
      : { limit: procurementPageSize, cursor: search.cursor }),
  };
}

const supplierSorts = new Set<string>(supplierSortSchema.options);

/**
 * Builds the supplier request for a view: conditions, sort (a catalog or custom field), search
 * text and the page cursor.
 */
export function supplierListQuery(
  state: CollectionViewState,
  search: Pick<ProcurementSearch, 'q' | 'cursor'>,
  timeZone: string,
): SupplierListQuery {
  const field = state.sort?.field;

  return {
    q: search.q?.trim() ?? '',
    ...(state.where.conditions.length
      ? { where: JSON.stringify(state.where) }
      : {}),
    sort:
      field && supplierSorts.has(field)
        ? (field as SupplierListQuery['sort'])
        : customSort(field)
          ? field
          : 'name',
    direction: state.sort?.direction ?? 'asc',
    timeZone,
    count: 'exact',
    limit: procurementPageSize,
    cursor: search.cursor,
  };
}

/** Reads one page of suppliers with their order counts and management permissions. */
export const suppliersOptions = (
  organizationId: string,
  query: SupplierListQuery = {},
) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'suppliers', 'list', query],
    ...privateQueryDefaults,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.suppliers({ params: { organizationId }, query }, { signal }),
  });

/** Reads one page of purchase orders with their stage, progress and workspace counts. */
export const ordersOptions = (
  organizationId: string,
  query: PurchaseOrderListQuery = {},
) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'orders', 'list', query],
    ...privateQueryDefaults,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.orders({ params: { organizationId }, query }, { signal }),
  });

/** Creates a supplier; callers retain the body for retries. */
export async function createSupplier(
  organizationId: string,
  body: SupplierInput,
) {
  return api.createSupplier({
    params: { organizationId },
    body,
  });
}

/** Creates a draft order; callers retain the body for retries. */
export async function createOrder(
  organizationId: string,
  body: PurchaseOrderInput,
) {
  return api.createOrder({ params: { organizationId }, body });
}

/** Applies a status command against the revision the user reviewed. */
export async function transitionOrder(
  organizationId: string,
  purchaseOrderId: string,
  body: TransitionInput,
) {
  return api.transition({
    params: { organizationId, purchaseOrderId },
    body,
  });
}

/** Describes permission, conflict and uncertain network failures. */
export function procurementError(error: unknown) {
  if (error instanceof ProcurementError) return error.feedback;

  return m.procurement_error_unconfirmed();
}

const read = <T>(
  key: readonly unknown[],
  fn: (signal: AbortSignal) => Promise<T>,
) =>
  queryOptions({
    queryKey: key,
    ...privateQueryDefaults,
    queryFn: ({ signal }) => fn(signal),
  });

/** Reads an order with its supplier lifecycle, evidence and next action. */
export const purchaseOrderRecordOptions = (
  organizationId: string,
  purchaseOrderId: string,
) =>
  read(
    [...procurementKey(organizationId), 'orders', purchaseOrderId, 'record'],
    (signal) =>
      api.record({ params: { organizationId, purchaseOrderId } }, { signal }),
  );

/** Reads stock, products, issues and replenishment evidence around an order. */
export const purchaseOrderContextOptions = (
  organizationId: string,
  purchaseOrderId: string,
) =>
  read(
    [...procurementKey(organizationId), 'orders', purchaseOrderId, 'context'],
    (signal) =>
      contextApi.order(
        { params: { organizationId, purchaseOrderId } },
        { signal },
      ),
  );

/** Reads a supplier record with its orders and messages. */
export const supplierRecordOptions = (
  organizationId: string,
  supplierId: string,
) =>
  read([...procurementKey(organizationId), 'suppliers', supplierId], (signal) =>
    api.supplier({ params: { organizationId, supplierId } }, { signal }),
  );

/** Reads stock for the SKUs a supplier provides. */
export const supplierContextOptions = (
  organizationId: string,
  supplierId: string,
) =>
  read(
    [...procurementKey(organizationId), 'suppliers', supplierId, 'context'],
    (signal) =>
      contextApi.supplier(
        { params: { organizationId, supplierId } },
        { signal },
      ),
  );

/** Lists connections that can act as purchasing systems. */
export const purchasingConnectionsOptions = (organizationId: string) =>
  read([...procurementKey(organizationId), 'purchasing'], (signal) =>
    api.purchasingConnections({ params: { organizationId } }, { signal }),
  );

/** Lists suppliers in one purchasing system, for linking. */
export const purchasingSuppliersOptions = (
  organizationId: string,
  connectionId: string,
) =>
  read(
    [
      ...procurementKey(organizationId),
      'purchasing',
      connectionId,
      'suppliers',
    ],
    (signal) =>
      api.purchasingSuppliers(
        { params: { organizationId, connectionId }, query: {} },
        { signal },
      ),
  );

/** Links a supplier to its purchasing-system record or removes the link. */
export async function linkSupplier(
  organizationId: string,
  supplierId: string,
  body: SupplierLinkInput,
) {
  return api.linkSupplier({ params: { organizationId, supplierId }, body });
}

/** Requests approval to send an order; callers retain the body for retries. */
export async function requestSubmission(
  organizationId: string,
  purchaseOrderId: string,
  body: { id: string; requestedDeliveryDate: string },
) {
  return api.requestSubmission({
    params: { organizationId, purchaseOrderId },
    body,
  });
}

/** Approves or rejects the exact submission the reader reviewed. */
export async function decideSubmission(
  organizationId: string,
  submissionId: string,
  body: { decisionId: string; outcome: 'approved' | 'rejected' },
) {
  return api.decideSubmission({
    params: { organizationId, submissionId },
    body,
  });
}

/** Sends an approved submission now; repeated calls return the recorded attempt. */
export async function sendSubmission(
  organizationId: string,
  submissionId: string,
) {
  return api.sendSubmission({
    params: { organizationId, submissionId },
    body: {},
  });
}

/** Reads the purchasing system to settle an uncertain submission. */
export async function checkSubmission(
  organizationId: string,
  submissionId: string,
) {
  return api.checkSubmission({
    params: { organizationId, submissionId },
    body: {},
  });
}

/** Reads the purchasing-system order now. */
export async function refreshPurchaseOrder(
  organizationId: string,
  purchaseOrderId: string,
) {
  return api.refresh({
    params: { organizationId, purchaseOrderId },
    body: {},
  });
}

/** Records a supplier message; callers retain the body for retries. */
export async function recordMessage(
  organizationId: string,
  purchaseOrderId: string,
  body: MessageInput,
) {
  return api.recordMessage({
    params: { organizationId, purchaseOrderId },
    body,
  });
}

/** Reads a message again after an unavailable or failed attempt. */
export async function readMessage(
  organizationId: string,
  communicationId: string,
) {
  return api.readMessage({
    params: { organizationId, communicationId },
    body: {},
  });
}

/** Removes a message's text, keeping its metadata and commitments. */
export async function removeMessageText(
  organizationId: string,
  communicationId: string,
) {
  return api.removeMessageText({
    params: { organizationId, communicationId },
    body: {},
  });
}

/** Records or corrects a commitment; callers retain the body for retries. */
export async function recordCommitment(
  organizationId: string,
  purchaseOrderId: string,
  body: CommitmentInput,
) {
  return api.recordCommitment({
    params: { organizationId, purchaseOrderId },
    body,
  });
}

/** Confirms or rejects a commitment that needed review. */
export async function reviewCommitment(
  organizationId: string,
  commitmentId: string,
  body: { outcome: 'confirmed' | 'rejected'; acceptChange?: boolean },
) {
  return api.reviewCommitment({
    params: { organizationId, commitmentId },
    body,
  });
}

/** Accepts a change or records a follow-up for an attention item. */
export async function respondToAttention(
  organizationId: string,
  purchaseOrderId: string,
  body: FollowUpInput,
) {
  return api.respond({ params: { organizationId, purchaseOrderId }, body });
}

/** Records cumulative receipt quantities with sourced evidence and an optimistic concurrency check. */
export async function recordReceipt(
  organizationId: string,
  purchaseOrderId: string,
  body: Parameters<typeof api.recordReceipt>[0]['body'],
) {
  return api.recordReceipt({
    params: { organizationId, purchaseOrderId },
    body,
  });
}

/** Counts authorized purchasing proposals before they become purchase orders. */
export const procurementProposalsOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [...procurementKey(organizationId), 'waiting-proposals'],
    refetchInterval: 30_000,
    queryFn: ({ signal }) =>
      client.decisions.list(
        {
          params: { organizationId },
          query: {
            view: 'all',
            scope: 'all',
            domain: 'procurement',
            reason: 'approval',
            limit: 1,
          },
        },
        { signal },
      ),
  });
