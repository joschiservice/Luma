import { m } from '@luma/i18n/messages';
import { queryOptions } from '@tanstack/react-query';

import { IdentityError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

/** A rejected return case request, with the server's explanation when it sent one. */
class ReturnCaseError extends IdentityError {
  constructor(
    status: number,
    readonly feedback: string,
  ) {
    super(status);
  }
}

const api = createWebApiClient(
  undefined,
  (status, body) =>
    new ReturnCaseError(
      status,
      typeof body === 'object' && body !== null && 'message' in body
        ? String(body.message)
        : m.returns_case_error_unavailable(),
    ),
).returnCases;

/** Explains a failed request; an unknown outcome is described as unconfirmed. */
export function returnCaseError(error: unknown) {
  if (error instanceof ReturnCaseError)
    return error.status === 403
      ? m.returns_case_error_access()
      : error.feedback;

  return m.returns_case_error_unconfirmed();
}

/** Whether a failed request may have been applied, so it must be retried with the same body. */
export const uncertainFailure = (error: unknown) =>
  !(error instanceof ReturnCaseError) || error.status >= 500;

/** Returns the private cache prefix for return cases in this workspace. */
export const returnCaseKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'return-cases'] as const;

/** Loads one return case with its lines, decisions, history and creation state. */
export function returnCaseOptions(organizationId: string, caseId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...returnCaseKey(organizationId), caseId],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.get({ params: { organizationId, caseId } }, { signal }),
  });
}

/** Loads an order's return cases and what each source can still return. */
export function orderReturnCasesOptions(
  organizationId: string,
  orderId: string,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...returnCaseKey(organizationId), 'order', orderId],
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.forOrder({ params: { organizationId, orderId } }, { signal }),
  });
}

/** Reads the warehouses and return reasons of the case's order system now. */
export function creationChoicesOptions(organizationId: string, caseId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...returnCaseKey(organizationId), caseId, 'creation-options'],
    staleTime: 0,
    queryFn: ({ signal }) =>
      api.creationOptions({ params: { organizationId, caseId } }, { signal }),
  });
}

type Body<K extends keyof typeof api> = Parameters<(typeof api)[K]>[0] extends {
  body: infer B;
}
  ? B
  : never;

export type OpenCaseBody = Body<'open'>;

export type ReceiptBody = Body<'recordReceipt'>;

export type InspectionBody = Body<'recordInspection'>;

export type ProposalBody = Body<'proposeResolution'>;

export type AssignBody = Body<'assign'>;

export type CancelBody = Body<'cancel'>;

export type CreationRequestBody = Body<'requestCreation'>;

/** Opens a case; the body's ID makes a retry after an uncertain response safe. */
export const openReturnCase = (
  organizationId: string,
  orderId: string,
  body: OpenCaseBody,
) => api.open({ params: { organizationId, orderId }, body });

/** Changes to one case. Each names a new command ID and the reviewed revision. */
export const caseCommands = (organizationId: string, caseId: string) => {
  const params = { organizationId, caseId };

  return {
    assign: (body: AssignBody) => api.assign({ params, body }),
    receipt: (body: ReceiptBody) => api.recordReceipt({ params, body }),
    inspection: (body: InspectionBody) =>
      api.recordInspection({ params, body }),
    proposal: (body: ProposalBody) => api.proposeResolution({ params, body }),
    cancel: (body: CancelBody) => api.cancel({ params, body }),
    requestCreation: (body: CreationRequestBody) =>
      api.requestCreation({ params, body }),
    decideCreation: (
      creationId: string,
      body: { decisionId: string; outcome: 'approved' | 'rejected' },
    ) => api.decideCreation({ params: { ...params, creationId }, body }),
    sendCreation: (creationId: string) =>
      api.sendCreation({ params: { ...params, creationId }, body: {} }),
    checkCreation: (creationId: string) =>
      api.checkCreation({ params: { ...params, creationId }, body: {} }),
  };
};
