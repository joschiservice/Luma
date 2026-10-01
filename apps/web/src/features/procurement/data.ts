import type {
  CommitmentInput,
  FollowUpInput,
  MessageInput,
  PurchaseOrderInput,
  SupplierInput,
  SupplierLinkInput,
  TransitionInput,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient().procurement;

export class ProcurementError extends IdentityError {
  constructor(
    status: number,
    readonly feedback: string,
  ) {
    super(status);
  }
}

function failure(response: { status: number; body: unknown }): never {
  const body = response.body;
  throw new ProcurementError(
    response.status,
    typeof body === 'object' && body !== null && 'message' in body
      ? String(body.message)
      : 'Procurement is unavailable. Try again.',
  );
}

/** Returns the private cache prefix for procurement in this workspace. */
export const procurementKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'procurement'] as const;

/** Reads the supplier directory with current management permissions. */
export const suppliersOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'suppliers'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const response = await api.suppliers({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (response.status !== 200) failure(response);

      return response.body;
    },
  });

/** Reads purchase orders with their persisted lifecycle state. */
export const ordersOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'orders'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const response = await api.orders({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (response.status !== 200) failure(response);

      return response.body;
    },
  });

/** Reads immutable order details and lifecycle evidence together. */
export const purchaseOrderOptions = (
  organizationId: string,
  purchaseOrderId: string,
) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'orders', purchaseOrderId],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const response = await api.detail({
        params: { organizationId, purchaseOrderId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (response.status !== 200) failure(response);

      return response.body;
    },
  });

/** Creates a supplier; callers retain the body for retries. */
export async function createSupplier(
  organizationId: string,
  body: SupplierInput,
) {
  const response = await api.createSupplier({
    params: { organizationId },
    body,
  });
  if (response.status !== 200) failure(response);

  return response.body;
}

/** Creates a draft order; callers retain the body for retries. */
export async function createOrder(
  organizationId: string,
  body: PurchaseOrderInput,
) {
  const response = await api.createOrder({ params: { organizationId }, body });
  if (response.status !== 200) failure(response);

  return response.body;
}

/** Applies a status command against the revision the user reviewed. */
export async function transitionOrder(
  organizationId: string,
  purchaseOrderId: string,
  body: TransitionInput,
) {
  const response = await api.transition({
    params: { organizationId, purchaseOrderId },
    body,
  });
  if (response.status !== 200) failure(response);

  return response.body;
}

/** Describes permission, conflict and uncertain network failures. */
export function procurementError(error: unknown) {
  if (error instanceof ProcurementError) return error.feedback;

  return 'The result could not be confirmed. Check your connection and retry the same request.';
}

const contextApi = createWebApiClient().procurementContext;

type Response = { status: number; body: unknown };

function ok<T extends Response>(
  response: T,
): Extract<T, { status: 200 }>['body'] {
  if (response.status !== 200) failure(response);

  return response.body as Extract<T, { status: 200 }>['body'];
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

const fetchOptions = (signal: AbortSignal) => ({
  signal,
  cache: 'no-store' as const,
});

/** Reads an order with its supplier lifecycle, evidence and next action. */
export const purchaseOrderRecordOptions = (
  organizationId: string,
  purchaseOrderId: string,
) =>
  read(
    [...procurementKey(organizationId), 'orders', purchaseOrderId, 'record'],
    async (signal) =>
      ok(
        await api.record({
          params: { organizationId, purchaseOrderId },
          fetchOptions: fetchOptions(signal),
        }),
      ),
  );

/** Reads stock, products, issues and replenishment evidence around an order. */
export const purchaseOrderContextOptions = (
  organizationId: string,
  purchaseOrderId: string,
) =>
  read(
    [...procurementKey(organizationId), 'orders', purchaseOrderId, 'context'],
    async (signal) =>
      ok(
        await contextApi.order({
          params: { organizationId, purchaseOrderId },
          fetchOptions: fetchOptions(signal),
        }),
      ),
  );

/** Reads each order's stage, expected date and attention for lists. */
export const progressOptions = (organizationId: string) =>
  read([...procurementKey(organizationId), 'progress'], async (signal) =>
    ok(
      await api.progress({
        params: { organizationId },
        fetchOptions: fetchOptions(signal),
      }),
    ),
  );

/** Reads a supplier record with its orders and messages. */
export const supplierRecordOptions = (
  organizationId: string,
  supplierId: string,
) =>
  read(
    [...procurementKey(organizationId), 'suppliers', supplierId],
    async (signal) =>
      ok(
        await api.supplier({
          params: { organizationId, supplierId },
          fetchOptions: fetchOptions(signal),
        }),
      ),
  );

/** Reads stock for the SKUs a supplier provides. */
export const supplierContextOptions = (
  organizationId: string,
  supplierId: string,
) =>
  read(
    [...procurementKey(organizationId), 'suppliers', supplierId, 'context'],
    async (signal) =>
      ok(
        await contextApi.supplier({
          params: { organizationId, supplierId },
          fetchOptions: fetchOptions(signal),
        }),
      ),
  );

/** Lists connections that can act as purchasing systems. */
export const purchasingConnectionsOptions = (organizationId: string) =>
  read([...procurementKey(organizationId), 'purchasing'], async (signal) =>
    ok(
      await api.purchasingConnections({
        params: { organizationId },
        fetchOptions: fetchOptions(signal),
      }),
    ),
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
    async (signal) =>
      ok(
        await api.purchasingSuppliers({
          params: { organizationId, connectionId },
          query: {},
          fetchOptions: fetchOptions(signal),
        }),
      ),
  );

/** Links a supplier to its purchasing-system record or removes the link. */
export async function linkSupplier(
  organizationId: string,
  supplierId: string,
  body: SupplierLinkInput,
) {
  return ok(
    await api.linkSupplier({ params: { organizationId, supplierId }, body }),
  );
}

/** Requests approval to send an order; callers retain the body for retries. */
export async function requestSubmission(
  organizationId: string,
  purchaseOrderId: string,
  body: { id: string; requestedDeliveryDate: string },
) {
  return ok(
    await api.requestSubmission({
      params: { organizationId, purchaseOrderId },
      body,
    }),
  );
}

/** Approves or rejects the exact submission the reader reviewed. */
export async function decideSubmission(
  organizationId: string,
  submissionId: string,
  body: { decisionId: string; outcome: 'approved' | 'rejected' },
) {
  return ok(
    await api.decideSubmission({
      params: { organizationId, submissionId },
      body,
    }),
  );
}

/** Sends an approved submission now; repeated calls return the recorded attempt. */
export async function sendSubmission(
  organizationId: string,
  submissionId: string,
) {
  return ok(
    await api.sendSubmission({
      params: { organizationId, submissionId },
      body: {},
    }),
  );
}

/** Reads the purchasing system to settle an uncertain submission. */
export async function checkSubmission(
  organizationId: string,
  submissionId: string,
) {
  return ok(
    await api.checkSubmission({
      params: { organizationId, submissionId },
      body: {},
    }),
  );
}

/** Reads the purchasing-system order now. */
export async function refreshPurchaseOrder(
  organizationId: string,
  purchaseOrderId: string,
) {
  return ok(
    await api.refresh({
      params: { organizationId, purchaseOrderId },
      body: {},
    }),
  );
}

/** Records a supplier message; callers retain the body for retries. */
export async function recordMessage(
  organizationId: string,
  purchaseOrderId: string,
  body: MessageInput,
) {
  return ok(
    await api.recordMessage({
      params: { organizationId, purchaseOrderId },
      body,
    }),
  );
}

/** Reads a message again after an unavailable or failed attempt. */
export async function readMessage(
  organizationId: string,
  communicationId: string,
) {
  return ok(
    await api.readMessage({
      params: { organizationId, communicationId },
      body: {},
    }),
  );
}

/** Removes a message's text, keeping its metadata and commitments. */
export async function removeMessageText(
  organizationId: string,
  communicationId: string,
) {
  return ok(
    await api.removeMessageText({
      params: { organizationId, communicationId },
      body: {},
    }),
  );
}

/** Records or corrects a commitment; callers retain the body for retries. */
export async function recordCommitment(
  organizationId: string,
  purchaseOrderId: string,
  body: CommitmentInput,
) {
  return ok(
    await api.recordCommitment({
      params: { organizationId, purchaseOrderId },
      body,
    }),
  );
}

/** Confirms or rejects a commitment that needed review. */
export async function reviewCommitment(
  organizationId: string,
  commitmentId: string,
  body: { outcome: 'confirmed' | 'rejected'; acceptChange?: boolean },
) {
  return ok(
    await api.reviewCommitment({
      params: { organizationId, commitmentId },
      body,
    }),
  );
}

/** Accepts a change or records a follow-up for an attention item. */
export async function respondToAttention(
  organizationId: string,
  purchaseOrderId: string,
  body: FollowUpInput,
) {
  return ok(
    await api.respond({ params: { organizationId, purchaseOrderId }, body }),
  );
}
