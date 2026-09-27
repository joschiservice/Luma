# Procurement records

`@luma/procurement` owns suppliers and purchase orders. Connector commerce
projections remain separate. A purchase order contains immutable line IDs, SKU,
description, quantity and unit, plus a supplier name snapshot. It does not model
prices, invoices, receipts or warehouse movements.

Owners and admins can create records and change order status. Members can read.
Every use case refreshes membership before accessing the tenant store. The
Procurement page uses the same API and permissions as other workspace pages.

## Ownership and provenance

Orders default to `authority: "luma"`; an external reference does not transfer
ownership. `authority: "external"` requires at least one external reference and
prevents local lifecycle changes. This foundation does not synchronize external
status. External mappings carry `system`, `externalId` and an optional
`connectionId`. These are provenance references, not execution grants.

Optional `origin.workflowRunId`, `origin.actionId` and `origin.outcomeId` retain
creation provenance. References do not prove that a workflow ran or passed
Action Admission. Procurement capabilities must call this owner service after
their authorization checks. A generic workflow subject or outcome can refer to
`{ kind: "purchase_order", id: purchaseOrder.id }` within its existing tenant
context. No procurement rule is added to the generic Workflow interpreter.

## Lifecycle

All new orders start as drafts.

| From               | Allowed next states |
| ------------------ | ------------------- |
| Draft              | Open, Cancelled     |
| Open               | Closed, Cancelled   |
| Closed / Cancelled | None                |

Opening records an operational commitment; it does not send the order to a
supplier. Closing records completion; it does not record goods received.
Transitions require a reason and the current revision. Terminal orders retain
all records and cannot reopen. Correct a draft by cancelling it and creating a
new order.

## Persistence and retries

Migration `0027_procurement.sql` creates supplier, purchase-order and command
tables with forced tenant RLS through the existing `luma_desk` role. A composite
supplier foreign key prevents cross-tenant relationships. Lines are embedded in
the purchase-order aggregate and keep stable IDs.

The service serializes writes per tenant. Reads share that lock so an order and
its audit history cannot straddle a write. The existing Audit owner writes on
the same transaction: records, command results and lifecycle audit commit or
roll back together. Each lifecycle event retains actor, time, reason, revision,
previous/next states and order reference. Workspace Activity classifies these
events as procurement and links back to the purchase order.

Creation IDs and transition command IDs are tenant-scoped idempotency keys.
Reuse the complete body and ID after an uncertain response. An exact retry by
the same actor returns the original result; a changed request returns 409.
A retry of an older command never rolls back the current order state. Read the
detail endpoint to obtain the current revision. The web dialogs retain uncertain
requests, freeze their fields and offer retry.

## Entry points and validation

- `packages/procurement/src/domain/procurement.ts`: records and lifecycle rules.
- `application/procurement.ts`: membership, commands and business operations.
- `infrastructure/store.ts`: transactional storage and audit composition.
- `packages/api-contract/src/contracts/procurement.ts`: documented HTTP surface.
- `apps/web/src/features/procurement`: directory, order list, details and forms.

Run `pnpm --filter @luma/procurement test`,
`pnpm test:e2e procurement.e2e.mjs` and
`pnpm test:browser procurement.browser.mjs`. Database tests use disposable
PostgreSQL with restricted runtime credentials. Browser tests exercise the real
API, response-loss recovery, persistence, filters and narrow screens.
