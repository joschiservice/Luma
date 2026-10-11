import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
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
  returnCreationOptionsSchema,
} from '../return-cases.js';

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

export const returnCasesContract = {
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
    .meta({ access: requires('returns.read'), errors: [401, 403, 404, 503] })
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
