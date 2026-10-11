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

/** Searches return cases with tenant-scoped source and customer filters. */
export function returnCasesOptions(
  organizationId: string,
  query: {
    q?: string;
    customerId?: string;
    openOnly?: boolean;
    cursor?: string;
    limit?: number;
  } = {},
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...returnCaseKey(organizationId), 'list', query],
    queryFn: ({ signal }) =>
      api.list({ params: { organizationId }, query }, { signal }),
  });
}

/** Loads one return case with its lines, decisions, history and creation state. */
export function returnCaseOptions(organizationId: string, caseId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...returnCaseKey(organizationId), caseId],
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
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

/** Loads separately verified return stock and financial steps. */
export function returnSettlementOptions(
  organizationId: string,
  caseId: string,
) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...returnCaseKey(organizationId), caseId, 'settlement'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    queryFn: ({ signal }) =>
      api.actions({ params: { organizationId, caseId } }, { signal }),
  });
}

/** Settlement commands keep request identity stable across uncertain HTTP responses. */
export function settlementCommands(organizationId: string, caseId: string) {
  const params = { organizationId, caseId };

  return {
    request: (body: Body<'requestAction'>) =>
      api.requestAction({ params, body }),
    decide: (actionId: string, body: Body<'decideAction'>) =>
      api.decideAction({ params: { ...params, actionId }, body }),
    send: (actionId: string) =>
      api.sendAction({ params: { ...params, actionId }, body: {} }),
    check: (actionId: string) =>
      api.checkAction({ params: { ...params, actionId }, body: {} }),
  };
}

/** Polls independently observed exchange state while the case is visible. */
export function returnExchangeOptions(organizationId: string, caseId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...returnCaseKey(organizationId), caseId, 'exchange'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    queryFn: ({ signal }) =>
      api.exchanges({ params: { organizationId, caseId } }, { signal }),
  });
}

/** Commands preserve the operation and exact step identities across uncertain responses. */
export function exchangeCommands(organizationId: string, caseId: string) {
  const params = { organizationId, caseId };

  return {
    request: (body: Body<'requestExchange'>) =>
      api.requestExchange({ params, body }),
    choose: (body: Body<'chooseExchange'>) =>
      api.chooseExchange({ params, body }),
    refund: (revision: number) =>
      api.refundExchange({ params, body: { revision } }),
    decide: (actionId: string, body: Body<'decideExchange'>) =>
      api.decideExchange({ params: { ...params, actionId }, body }),
    send: (actionId: string) =>
      api.sendExchange({ params: { ...params, actionId }, body: {} }),
    check: (actionId: string) =>
      api.checkExchange({ params: { ...params, actionId }, body: {} }),
  };
}

/** Loads durable waits without refreshing a provider. */
export function returnWaitingOptions(organizationId: string, caseId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...returnCaseKey(organizationId), caseId, 'waiting'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    queryFn: ({ signal }) =>
      api.waiting({ params: { organizationId, caseId } }, { signal }),
  });
}

/** Reads merchant deadline configuration. */
export function returnDeadlineOptions(organizationId: string) {
  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...returnCaseKey(organizationId), 'deadlines'],
    queryFn: ({ signal }) =>
      api.deadlines({ params: { organizationId } }, { signal }),
  });
}

/** Saves one immutable policy command and explicitly checks read-only return progress. */
export const returnDeadlineCommands = (organizationId: string) => ({
  configure: (body: Parameters<typeof api.configureDeadlines>[0]['body']) =>
    api.configureDeadlines({ params: { organizationId }, body }),
  check: (caseId: string) =>
    api.checkWaiting({ params: { organizationId, caseId }, body: {} }),
});
