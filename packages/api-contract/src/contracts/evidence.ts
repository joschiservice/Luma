import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';
import { evidenceListSchema, evidenceRequestSchema } from '../evidence.js';

export const evidenceContract = {
  resolve: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/evidence/resolve',
      summary: 'Resolve the evidence a record cites',
      description:
        "Resolves the references a purchase order, purchasing plan, native stock receipt, return write, reply, case or app decision cites. Each reference is a stored provider read (source, record, read time, source update time and revision, completeness, adapter version and a normalized summary), a provider write receipt (capability, accepted time, provider records and request ID), a stored mailbox message (sender, received time, subject and whether the sender was authenticated, never its text), a Luma record (some with their time, actor and recorded facts, such as a purchase order's lifecycle events and stock ledger entries with their postings), `restricted` when another area guards it and the reader lacks that permission, `not_retained` when it was cited before Luma stored that kind of evidence, or `unresolved`. Without `refs`, resolves every reference the subject cites, up to 100. Needs the read permission of the subject: `procurement.read` for purchase orders and plans, `inventory.read` for native receipts, `returns.read`, `messages.read`, `issues.read`, and for app decisions the read permission of the change's area. Provider payloads, message text and credentials are never returned.",
    })
    .meta({
      access: requires([
        'procurement.read',
        'inventory.read',
        'returns.read',
        'messages.read',
        'issues.read',
        'orders.read',
        'fulfillment.read',
      ]),
      errors: [401, 403, 404, 503],
      readOnly: true,
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: evidenceRequestSchema,
      }),
    )
    .output(evidenceListSchema),
};
