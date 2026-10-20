import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import {
  requestReturnActionSchema,
  returnActionListSchema,
  returnActionSchema,
} from '../return-actions.js';
import {
  assignReturnCaseSchema,
  cancelReturnCaseSchema,
  decideReturnCreationSchema,
  openReturnCaseSchema,
  orderReturnCasesSchema,
  proposeResolutionSchema,
  recordInspectionSchema,
  recordReceiptSchema,
  requestReturnCreationSchema,
  returnCaseDetailSchema,
  returnCaseListSchema,
  returnCreationOptionsSchema,
} from '../return-cases.js';
import {
  configureReturnDeadlinesSchema,
  returnDeadlinePolicySchema,
  returnWaitingViewSchema,
} from '../return-deadlines.js';
import {
  exchangeChoiceInputSchema,
  exchangeConsistencySchema,
  exchangeRequestSchema,
  exchangeStepSchema,
  returnExchangeSchema,
  returnExchangesSchema,
} from '../return-exchanges.js';

const path = '/v1/organizations/{organizationId}';

const orderParams = organizationParamsSchema.extend({
  orderId: z.string().uuid(),
});

const caseParams = organizationParamsSchema.extend({
  caseId: z.string().uuid(),
});

const creationParams = caseParams.extend({ creationId: z.string().uuid() });

const empty = z.object({}).strict();

const writes = {
  access: requires('returns.manage'),
  errors: [401, 403, 404, 409, 422, 503],
} as const;

/** A change to one case, checked against `expectedRevision` and keyed by `commandId`. */
function caseCommand<T extends z.ZodTypeAny>(
  segment: string,
  summary: string,
  description: string,
  body: T,
) {
  return endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/${segment}`,
      summary,
      description,
    })
    .meta(writes)
    .input(z.object({ params: caseParams, body }))
    .output(returnCaseDetailSchema);
}

const actionParams = caseParams.extend({ actionId: z.string().uuid() });

export const returnCasesContract = {
  deadlines: endpoint
    .route({
      method: 'GET',
      path: `${path}/return-deadlines`,
      summary: 'Read merchant return deadlines',
      description:
        'Reads configured hours anchored to recorded case events. Configuration alone does not turn on automatic monitoring.',
    })
    .meta({ access: requires('returns.read'), errors: [401, 403, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(returnDeadlinePolicySchema),
  configureDeadlines: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-deadlines`,
      summary: 'Configure merchant return deadlines',
      description:
        'Saves a revision-checked policy. Exact command retries retain the original version. Activate Return step follow-up in Workflows to monitor automatically.',
    })
    .meta(writes)
    .input(
      z.object({
        params: organizationParamsSchema,
        body: configureReturnDeadlinesSchema,
      }),
    )
    .output(returnDeadlinePolicySchema),
  waiting: endpoint
    .route({
      method: 'GET',
      path: `${path}/return-cases/{caseId}/waiting`,
      summary: 'Read durable return waiting',
      description:
        'Reads owned waits, escalation and earlier occurrences without refreshing provider evidence.',
    })
    .meta({ access: requires('returns.read'), errors: [401, 403, 404, 503] })
    .input(z.object({ params: caseParams }))
    .output(returnWaitingViewSchema),
  checkWaiting: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/waiting/check`,
      summary: 'Check return progress',
      description:
        'Independently rereads financial evidence and records actual receipt and inspection progress. It executes no provider write.',
    })
    .meta(writes)
    .input(z.object({ params: caseParams, body: empty }))
    .output(returnWaitingViewSchema),
  exchanges: endpoint
    .route({
      method: 'GET',
      path: `${path}/return-cases/{caseId}/exchange`,
      summary: 'Read tracked return exchange',
      description:
        'Reads the operation, independent fulfillment and payment proof, and explicitly mapped replacement choices.',
    })
    .meta({ access: requires('returns.read'), errors: [401, 403, 404, 503] })
    .input(z.object({ params: caseParams }))
    .output(returnExchangesSchema),
  completeExchange: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/exchange/complete`,
      summary: 'Verify exchange consistency in both systems',
      description:
        'Independently reads Shopify and Wawi. Completes the case only when returned stock, exactly one replacement order, its reservation, price and actual payment agree. A failed later check reopens owned work. Executes no provider write.',
    })
    .meta(writes)
    .input(z.object({ params: caseParams, body: empty }))
    .output(exchangeConsistencySchema),
  requestExchange: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/exchange/steps`,
      summary: 'Request exchange step approval',
      description:
        'Freezes one native request, process, cancellation or payment hold release for independent approval. All attempts retain the same case operation. Uncertain sent writes are checked without redispatch.',
    })
    .meta(writes)
    .input(z.object({ params: caseParams, body: exchangeRequestSchema }))
    .output(exchangeStepSchema),
  chooseExchange: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/exchange/choice`,
      summary: 'Choose how to handle replacement availability',
      description:
        'Records wait, different item or refund with an owner. The choice does not send a provider write. A different item or refund requires independently approved and freshly verified cancellation first.',
    })
    .meta(writes)
    .input(z.object({ params: caseParams, body: exchangeChoiceInputSchema }))
    .output(returnExchangeSchema),
  refundExchange: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/exchange/refund`,
      summary: 'Hand off a cancelled exchange to refund',
      description:
        'After fresh cancellation proof, changes the proposal to refund while preserving physical inspection and restock quantities. Refunding remains a separately approved settlement.',
    })
    .meta(writes)
    .input(
      z.object({
        params: caseParams,
        body: z.object({ revision: z.number().int().positive() }).strict(),
      }),
    )
    .output(z.object({ caseId: z.string().uuid() })),
  decideExchange: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/exchange/steps/{actionId}/decision`,
      summary: 'Approve an exact exchange step',
      description:
        'A current independent approver responds to the frozen step. Execution uses the requester’s rechecked authority.',
    })
    .meta(writes)
    .input(z.object({ params: actionParams, body: decideReturnCreationSchema }))
    .output(exchangeStepSchema),
  sendExchange: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/exchange/steps/{actionId}/send`,
      summary: 'Send an approved exchange step',
      description:
        'Resumes the same durable execution identity. A sent uncertain effect is reconciled without creating a second replacement.',
    })
    .meta(writes)
    .input(z.object({ params: actionParams, body: empty }))
    .output(exchangeStepSchema),
  checkExchange: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/exchange/steps/{actionId}/check`,
      summary: 'Verify exchange fulfillment and payment',
      description:
        'Independently reads the exact native replacement, fulfillment and financial outcome. Provider acceptance does not prove payment or case closure.',
    })
    .meta(writes)
    .input(z.object({ params: actionParams, body: empty }))
    .output(exchangeStepSchema),
  actions: endpoint
    .route({
      method: 'GET',
      path: `${path}/return-cases/{caseId}/settlements`,
      summary: 'Read return settlement',
      description:
        'Reads recorded physical and financial actions. Managers with a restock proposal also receive current Wawi warehouse choices for explicitly mapped items.',
    })
    .meta({ access: requires('returns.read'), errors: [401, 403, 404, 503] })
    .input(z.object({ params: caseParams }))
    .output(returnActionListSchema),
  requestAction: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/settlements`,
      summary: 'Request return settlement approval',
      description:
        'Freezes the provider-calculated refund or the inspected resale units at an explicitly mapped warehouse. Refunds never restock goods. An independent approver must authorize the exact action.',
    })
    .meta(writes)
    .input(z.object({ params: caseParams, body: requestReturnActionSchema }))
    .output(returnActionSchema),
  decideAction: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/settlements/{actionId}/decision`,
      summary: 'Approve return settlement',
      description:
        'A current independent approver responds to the frozen action. Approval dispatches once as the requester after their authority and case facts are checked again.',
    })
    .meta(writes)
    .input(z.object({ params: actionParams, body: decideReturnCreationSchema }))
    .output(returnActionSchema),
  sendAction: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/settlements/{actionId}/send`,
      summary: 'Send approved return settlement',
      description:
        'The requester sends an approved action through Action Admission. Repeated calls do not duplicate the provider effect.',
    })
    .meta(writes)
    .input(z.object({ params: actionParams, body: empty }))
    .output(returnActionSchema),
  checkAction: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/settlements/{actionId}/check`,
      summary: 'Verify return settlement',
      description:
        'Independently reads the exact stock change or refund payment. Pending, failed and uncertain outcomes stay distinct. This command never sends a provider write.',
    })
    .meta(writes)
    .input(z.object({ params: actionParams, body: empty }))
    .output(returnActionSchema),
  list: endpoint
    .route({
      method: 'GET',
      path: `${path}/return-cases`,
      summary: 'Find return cases',
      description:
        'Searches persisted return cases by case, order, source identity or item. Customer filtering also requires customers.read and follows source order mappings. No provider is called. The cursor is bound to the tenant and filters.',
    })
    .meta({
      publicApi: true,
      access: requires('returns.read'),
      errors: [401, 403, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: z.object({
          q: z.string().max(120).default(''),
          customerId: z.string().uuid().optional(),
          openOnly: z
            .union([
              z.boolean(),
              z.enum(['true', 'false']).transform((value) => value === 'true'),
            ])
            .optional(),
          cursor: z.string().max(4096).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
      }),
    )
    .output(returnCaseListSchema),
  forOrder: endpoint
    .route({
      method: 'GET',
      path: `${path}/orders/{orderId}/return-cases`,
      summary: 'List an order’s return cases',
      description:
        'Requires `returns.read`. Lists the order’s return cases and, for each source of the order, how many units of every line are ordered, already in return cases or in store returns no case works, and still returnable. Each unit counts once: a store return that a case works counts only through that case.',
    })
    .meta({ access: requires('returns.read'), errors: [401, 403, 404, 503] })
    .input(z.object({ params: orderParams }))
    .output(orderReturnCasesSchema),
  open: endpoint
    .route({
      method: 'POST',
      path: `${path}/orders/{orderId}/return-cases`,
      summary: 'Open a return case',
      description:
        'Requires `returns.manage`. Opens a return case on lines of one source of the order, with whole units, a reason per line and an optional note. Pass `sourceReturnId` to work a store return of that source; one open case works a store return. Lines can’t claim more units than are still returnable. The ID is the idempotency key: reuse it with the same body after an uncertain response.',
    })
    .meta(writes)
    .input(z.object({ params: orderParams, body: openReturnCaseSchema }))
    .output(returnCaseDetailSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: `${path}/return-cases/{caseId}`,
      summary: 'Inspect a return case',
      description:
        'Requires `returns.read`. Reads a return case with its lines, the receipt, inspection and proposed resolution with who decided them and on which evidence, the case history, and the latest request to create the return in the order’s system.',
    })
    .meta({
      publicApi: true,
      access: requires('returns.read'),
      errors: [401, 403, 404, 503],
    })
    .input(z.object({ params: caseParams }))
    .output(returnCaseDetailSchema),
  assign: caseCommand(
    'assignee',
    'Assign a return case',
    'Requires `returns.manage`. Assigns receiving and inspecting to a current member who can manage returns, or clears the assignee with null. Every change names a new `commandId` and the case’s current `expectedRevision`.',
    assignReturnCaseSchema,
  ),
  recordReceipt: caseCommand(
    'receipt',
    'Record what arrived',
    'Requires `returns.manage`. Records the received units of every case line, never more than requested, with optional evidence. A new receipt replaces the earlier one and clears the inspection and proposal that relied on it; the history keeps both.',
    recordReceiptSchema,
  ),
  recordInspection: caseCommand(
    'inspection',
    'Record the inspection',
    'Requires `returns.manage`. Judges every received unit of each line as resellable or damaged. Units requested but not received are missing. Needs a recorded receipt and clears an earlier proposal.',
    recordInspectionSchema,
  ),
  proposeResolution: caseCommand(
    'proposal',
    'Propose a resolution',
    'Requires `returns.manage`. Proposes a refund, exchange, store credit or rejection, with the units of each line to restock. Only units inspected as resellable can be restocked, and a rejection restocks nothing. A proposal changes nothing in the store.',
    proposeResolutionSchema,
  ),
  cancel: caseCommand(
    'cancel',
    'Cancel a return case',
    'Requires `returns.manage`. Cancels the case with a reason; its units can be returned again. Refused while the return is being created in the order’s system.',
    cancelReturnCaseSchema,
  ),
  creationOptions: endpoint
    .route({
      method: 'GET',
      path: `${path}/return-cases/{caseId}/creation-options`,
      summary: 'List warehouses and return reasons',
      description:
        'Requires `returns.manage`. Reads the warehouses and return reasons of the system the case’s order came from, to create the return there.',
    })
    .meta({
      access: requires('returns.manage'),
      errors: [401, 403, 404, 503],
    })
    .input(z.object({ params: caseParams }))
    .output(returnCreationOptionsSchema),
  requestCreation: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/creations`,
      summary: 'Request a return in the order’s system',
      description:
        'Requires `returns.manage`. Asks for approval to create this case’s return, with its lines, the chosen warehouse and one return reason, in the system the order came from. Someone else with `returns.manage`, `decisions.respond` and the app’s permission approves. Luma then creates it once and verifies it with an independent read; an uncertain result is only ever checked by reading. Observe-only workspaces and connections record the request and send nothing. Requests expire after 24 hours. Reuse the ID and body after an uncertain response.',
    })
    .meta(writes)
    .input(z.object({ params: caseParams, body: requestReturnCreationSchema }))
    .output(returnCaseDetailSchema),
  decideCreation: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/creations/{creationId}/decision`,
      summary: 'Approve or reject creating a return',
      description:
        'Requires `returns.manage` and `decisions.respond`, plus the app permission of the creating capability. Someone other than the requester approves or rejects the exact request. Approval creates the return as the requester after their membership and the case are checked again.',
    })
    .meta(writes)
    .input(
      z.object({ params: creationParams, body: decideReturnCreationSchema }),
    )
    .output(returnCaseDetailSchema),
  sendCreation: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/creations/{creationId}/send`,
      summary: 'Create an approved return now',
      description:
        'Requires `returns.manage`. The requester creates an approved return that was not sent. Repeated calls return the recorded attempt.',
    })
    .meta(writes)
    .input(z.object({ params: creationParams, body: empty }))
    .output(returnCaseDetailSchema),
  checkCreation: endpoint
    .route({
      method: 'POST',
      path: `${path}/return-cases/{caseId}/creations/{creationId}/check`,
      summary: 'Check an uncertain return',
      description:
        'Requires `returns.manage`. Reads the order’s system to settle whether an uncertain request created the return. It never sends the request again.',
    })
    .meta(writes)
    .input(z.object({ params: creationParams, body: empty }))
    .output(returnCaseDetailSchema),
};
