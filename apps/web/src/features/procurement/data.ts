import type {
  PurchaseOrderInput,
  SupplierInput,
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
