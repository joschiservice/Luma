import '@luma/identity/http';

import { apiContract } from '@luma/api-contract';
import { IdentityError } from '@luma/identity';
import type { HttpContext } from '@luma/identity/http';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { ProcurementService } from '../application/procurement.js';
import type { SupplierEmail } from '../application/supplier-email.js';

/** Registers tenant-authorized supplier drafts; approved delivery remains in the Operations Inbox. */
export function supplierEmailRoutes(
  service?: SupplierEmail,
  procurement?: ProcurementService,
) {
  const os = implement(apiContract.procurementEmail).$context<HttpContext>();
  const use = (request: FastifyRequest) => {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Supplier email is unavailable',
      );

    return { context: request.tenantContext, service };
  };

  return os.router({
    document: os.document.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return s.service.document(
          s.context,
          params.purchaseOrderId,
          params.outboundId,
        );
      },
    ),
    contact: os.contact.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);
        if (!procurement)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Supplier contact editing is unavailable',
          );

        return procurement.updateSupplierContact(
          s.context,
          params.supplierId,
          body,
        );
      },
    ),
    status: os.status.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return s.service.status(s.context, params.purchaseOrderId);
      },
    ),
    submission: os.submission.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.submission(s.context, params.purchaseOrderId, body);
      },
    ),
    followUp: os.followUp.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return s.service.followUp(s.context, params.purchaseOrderId, body);
      },
    ),
  });
}
