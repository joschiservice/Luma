# Procurement records

`@luma/procurement` owns suppliers and purchase orders, separate from connector commerce
projections. Every write is revision-checked, idempotent and audited in the same
transaction. A purchase order holds versioned lines (ID, SKU, description, quantity, unit)
and a supplier name snapshot. Drafting also snapshots the supplier article number and unit
price when terms report a currency. Governed callers must supply that snapshot in their admitted intent; drafting never enriches already approved parameters. It does not model invoices or warehouse movements.
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
orders cannot reopen. Correct a draft by cancelling it and creating a new order. An uncertain or submitted native order cannot be cancelled through a local lifecycle transition: cancellation requires a supported and verified provider change.

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

## Supplier purchasing terms

Purchasing terms belong to the supplier and canonical SKU pair. Missing values stay unknown;
pack size, minimum quantity and lead time never acquire a silent default. A product can have
terms for several suppliers. A manager records a reason when choosing a preferred supplier
or changing a term, and must remove an existing preference before choosing another.

Provider reads and imports remain observations. Human overrides apply only to the fields
they name and remain separate from those observations. A later provider read cannot erase
an override. Each changed value appends a version, preserving prices, actor, source identity,
read time and completeness; stale reads cannot replace newer evidence. A partial read never
removes pairs it did not return. Draft prices are fixed at drafting time, so a later price
change never rewrites an existing order.

Supplier terms are released per workspace through the `supplier-purchasing-terms` flag.
Both the API and worker enforce it. Reading requires current `procurement.read`; recording
terms or importing purchasing-system observations requires current `procurement.manage`.
The same tenant transaction commits a term, its retry result and its audit evidence.

## Reviewed purchasing plans

The purchasing workbench groups canonical products by supplier. Available stock already
accounts for source reservations; reservations are shown separately and are never subtracted
again. Competing sources are not summed. Native-owned locations use ledger balances.
Incoming supplier orders, transfers and native incoming balances use the same projection as
Inventory and Products. Incoming units never increase available stock.

Demand is an explicit average over a selected, completely imported order-history window.
Missing history, stale stock, missing pack sizes or minimum quantities withhold a quantity.
An active replenishment rule can supply its minimum and target without inventing demand.
Open drafts and orders suppress a second suggestion. A saved plan retains manual quantity
changes beside the original suggestion and evidence.

Each supplier plan has one immutable request and one governed action. Workspace approval
rules apply. Independent readback verifies the exact draft, including price and location
snapshots. A process interruption can resume the original approval and action. An uncertain
creation is reconciled by reading. Pending and uncertain plans reserve their products, and
the procurement transaction checks existing orders again before inserting the draft.

`purchasing-workbench` releases the view; `purchasing-plans` releases new governed drafts.
Disabling a write release does not prevent reconciliation of existing attempts.

## Observed purchasing outcomes

Plans retain the suggestion and chosen quantity. Explicit ignored decisions capture the
server recommendation with the person's reason. Later stock and receipt observations
establish outcomes; a saved plan or a manual receipt claim alone does not.

Availability through receipt requires independently verified receipt evidence, usable stock
reads no more than five minutes apart, and a fresh positive stock read after receipt. Gaps
remain unknown. Stockout duration is an observed interval between reads, never an estimated
duration across a gap. These observations do not prove counterfactual prevented loss.
Insights separates observed availability, observed stockouts and unknowns under
`purchasing-outcomes`.
