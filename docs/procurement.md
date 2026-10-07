# Procurement records

`@luma/procurement` owns suppliers and purchase orders, separate from connector commerce
projections. Every write is revision-checked, idempotent and audited in the same
transaction. A purchase order holds immutable lines (ID, SKU, description, quantity, unit)
and a supplier name snapshot; it does not model prices, invoices or warehouse movements.
Submission to a supplier, confirmations and receipts are covered in
[Supplier commitments](supplier-commitments.md).

`procurement.manage` creates records and changes order status; `procurement.read` reads
them. Every use case refreshes membership before touching the tenant store.

## Ownership and provenance

Orders default to `authority: "luma"`; an external reference does not transfer ownership.
`authority: "external"` requires at least one external reference and blocks local
lifecycle changes. External status is not synchronized. External mappings and connection
IDs are provenance references, not execution grants.

`origin` workflow run, action and outcome IDs record creation provenance. They do not prove
that a workflow ran or passed Action Admission. Procurement capabilities must call this
owner service after their own authorization checks. Generic workflows may refer to a
`purchase_order` subject within their tenant context, but no procurement rule belongs in
the generic Workflow interpreter.

A supplier can be linked to its record in one purchasing-system connection, with the hours
it has to confirm a sent order. Link changes are revision-checked and audited.

## Lifecycle

All new orders start as drafts.

| From               | Allowed next states |
| ------------------ | ------------------- |
| Draft              | Open, Cancelled     |
| Open               | Closed, Cancelled   |
| Closed / Cancelled | None                |

Opening records an operational commitment; it does not send the order. A verified
submission moves a draft to open. Closing records completion, not receipt; receipt is read
from the purchasing system. Transitions need a reason and the current revision. Terminal
orders cannot reopen. Correct a draft by cancelling it and creating a new order.

## Concurrency and retries

The service serializes writes per tenant, and reads share that lock so an order and its
audit history never straddle a write. Records, command results and lifecycle audit commit
or roll back together. A composite supplier foreign key prevents cross-tenant references.

Creation IDs and transition command IDs are tenant-scoped idempotency keys. After an
uncertain response, resend the same ID and body: an exact retry by the same actor returns
the original result, a changed request returns 409, and an older command never rolls back
the current state.

## Capabilities and effects

Procurement exposes versioned capabilities for supplier lookup, open purchase-order
lookup, Luma-owned draft creation and audited lifecycle transition. Each parses its input at
runtime and goes through the owner service, so membership and tenant checks apply to every
call. Inventory context comes from connector `inventory.read`; there is no broad
procurement capability. The supplier follow-up workflow adds `procurement.follow-up.record`.

Draft creation and transition are bound to Action Admission only when execution is enabled.
The target is a tenant-owned `purchase_order` UUID, and the connection ID is the tenant ID
for this internal service. Creation reuses the order ID as its command key; a transition
carries a stable command ID, target status, expected revision and reason, and its expected
postcondition must name the resulting status. Risk floors are medium for creation and high
for transitions, so both need approval.

Verification is an independent read of tenant, ownership, status, revision and the command
audit record; creation also compares supplier, reference, lines and origin. An unavailable
read is inconclusive. The in-memory simulated owner keeps the same validation, retry and
audit behavior for deterministic scenario evaluation.
