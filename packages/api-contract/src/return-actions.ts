import { z } from 'zod';

const ref = z.object({ externalId: z.string(), scopeKey: z.string() });
const plan = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('refund'),
    order: ref,
    lines: z.array(z.object({ orderLine: ref, quantity: z.number() })),
    amount: z.string(),
    currency: z.string(),
    transactions: z.array(
      z.object({
        parentId: z.string(),
        gateway: z.string(),
        amount: z.string(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('restock'),
    item: ref,
    warehouse: ref,
    quantity: z.number(),
    baselineOnHand: z.string(),
  }),
]);

/** Records approval, dispatch and independent proof separately for one return settlement. */
export const returnActionSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  connectionId: z.string().uuid(),
  orderLineId: z.string().nullable(),
  kind: z.enum(['refund', 'restock']),
  plan,
  requestedBy: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionId: z.string().nullable(),
  state: z.enum([
    'approval_required',
    'approved',
    'rejected',
    'expired',
    'sending',
    'uncertain',
    'pending',
    'verified',
    'failed',
    'not_executed',
  ]),
  sent: z.boolean(),
  failure: z.string().nullable(),
  updatedAt: z.string(),
  proof: z
    .object({
      outcome: z.enum(['passed', 'failed', 'inconclusive']),
      payment: z.enum(['pending', 'failed', 'paid']).nullable(),
      observedAt: z.string(),
      evidenceRefs: z.array(z.string()),
    })
    .nullable(),
  canApprove: z.boolean(),
  canSend: z.boolean(),
  canCheck: z.boolean(),
  observeOnly: z.boolean(),
});

/** Available restock targets follow exact canonical item mappings and independent current warehouse reads. */
export const returnActionListSchema = z.object({
  items: z.array(returnActionSchema),
  available: z.boolean(),
  asOf: z.string().datetime(),
  targetStatus: z.enum([
    'ready',
    'unavailable',
    'not_configured',
    'not_required',
  ]),
  targets: z.array(
    z.object({
      id: z.string(),
      orderLineId: z.string(),
      connectionId: z.string(),
      label: z.string(),
      item: ref,
      warehouse: ref,
      mappingIds: z.array(z.string()),
    }),
  ),
});

export const requestReturnActionSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['refund', 'restock']),
    targetId: z.string().max(256).optional(),
  })
  .strict();

export type ReturnActionView = z.infer<typeof returnActionSchema>;

export type ReturnActionList = z.infer<typeof returnActionListSchema>;
