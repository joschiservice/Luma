import { orderDetailSchema } from '@luma/api-contract';
import type { AppUiProps } from '@luma/app-host/web';

import { createWebApiClient } from '../../lib/api-client';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

/** Reads Luma context only after an exact, unambiguous source order mapping. */
export const loadCustomerOrderContext: (
  organizationId: string,
  connectionId: string,
  externalId: string,
) => ReturnType<NonNullable<AppUiProps['services']['orderContext']>> = async (
  organizationId,
  connectionId,
  externalId,
) => {
  const result = await api.records.resolve({
    params: { organizationId },
    query: { connectionId, externalId, kind: 'order' },
    fetchOptions: { cache: 'no-store' },
  });
  if (result.status !== 200)
    throw new IdentityError(result.status, result.body);
  if (result.body.ids.length !== 1)
    return {
      status: result.body.ids.length ? 'ambiguous' : 'unmapped',
      order: null,
    };
  const detail = await api.orders.get({
    params: { organizationId, orderId: result.body.ids[0]! },
    fetchOptions: { cache: 'no-store' },
  });
  if (detail.status === 404) return { status: 'unmapped', order: null };
  if (detail.status !== 200)
    throw new IdentityError(detail.status, detail.body);

  return { status: 'matched', order: orderDetailSchema.parse(detail.body) };
};
