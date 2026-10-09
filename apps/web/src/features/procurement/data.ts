import type {
  CommitmentInput,
  FollowUpInput,
  MessageInput,
  PurchaseOrderInput,
  SupplierInput,
  SupplierLinkInput,
  TransitionInput,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

/** A rejected procurement request, with the server's explanation when it sent one. */
export class ProcurementError extends IdentityError {
  constructor(
    status: number,
    readonly feedback: string,
  ) {
    super(status);
  }
}

const client = createWebApiClient(
  undefined,
  (status, body) =>
    new ProcurementError(
      status,
      typeof body === 'object' && body !== null && 'message' in body
        ? String(body.message)
        : m.procurement_error_unavailable(),
    ),
);
const api = client.procurement;
const contextApi = client.procurementContext;

/** Returns the private cache prefix for procurement in this workspace. */
export const procurementKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'procurement'] as const;

/** Reads the supplier directory with current management permissions. */
export const suppliersOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'suppliers'],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.suppliers({ params: { organizationId } }, { signal }),
  });

/** Reads purchase orders with their persisted lifecycle state. */
export const ordersOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'orders'],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.orders({ params: { organizationId } }, { signal }),
  });

/** Reads immutable order details and lifecycle evidence together. */
export const purchaseOrderOptions = (
  organizationId: string,
  purchaseOrderId: string,
) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'orders', purchaseOrderId],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.detail({ params: { organizationId, purchaseOrderId } }, { signal }),
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

/** Reads each order's stage, expected date and attention for lists. */
export const progressOptions = (organizationId: string) =>
  read([...procurementKey(organizationId), 'progress'], (signal) =>
    api.progress({ params: { organizationId } }, { signal }),
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
