import type {
  SupplierContactInput,
  SupplierEmailInput,
  SupplierFollowUpInput,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { privateQueryDefaults } from '../../lib/private-query';
import { createProcurementClient, procurementKey } from './data';

const api = createProcurementClient().procurementEmail;

/** Reads existing supplier mail alongside the server's tenant release decision. */
export const supplierEmailOptions = (
  organizationId: string,
  purchaseOrderId: string,
) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'email', purchaseOrderId],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.status({ params: { organizationId, purchaseOrderId } }, { signal }),
  });

/** Creates a reviewable supplier order draft; the caller retains its ID on uncertain responses. */
export const draftSupplierOrder = (
  organizationId: string,
  purchaseOrderId: string,
  body: SupplierEmailInput,
) => api.submission({ params: { organizationId, purchaseOrderId }, body });

/** Creates a supplier follow-up draft without moving the deadline. */
export const draftSupplierFollowUp = (
  organizationId: string,
  purchaseOrderId: string,
  body: SupplierFollowUpInput,
) => api.followUp({ params: { organizationId, purchaseOrderId }, body });

/** Updates contact details with a revision check and an idempotent command ID. */
export const updateSupplierContact = (
  organizationId: string,
  supplierId: string,
  body: SupplierContactInput,
) => api.contact({ params: { organizationId, supplierId }, body });

/** Downloads the exact persisted PDF that a supplier send approval binds. */
export async function downloadSupplierOrder(
  organizationId: string,
  purchaseOrderId: string,
  outboundId: string,
) {
  const document = await api.document({
    params: { organizationId, purchaseOrderId, outboundId },
  });
  const bytes = Uint8Array.from(atob(document.base64), (char) =>
    char.charCodeAt(0),
  );
  const url = URL.createObjectURL(
    new Blob([bytes], { type: document.mimeType }),
  );
  const anchor = globalThis.document.createElement('a');
  anchor.href = url;
  anchor.download = document.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
