# ADR-013: Quantity ledger and stock ownership

Status: Accepted. Date: 2026-10-12.

## Context

Editable orders do not establish stock ownership. Provider observations describe independent,
possibly incomplete stock reports; they cannot safely serve as a merchant's reservation ledger.
Native orders need retry-safe allocation, retained corrections and deliberate ownership cutover.
The quantity model must fit the existing tenant isolation, owner transactions and controlled actions.

## Decision

Inventory owns a double-entry quantity ledger in PostgreSQL. Use the shared migration runner,
forced tenant RLS and a restricted Inventory runtime role. Canonical provider snapshots remain
immutable evidence beside it; importing or comparing them does not post stock or change authority.
This decision defines the implementation contract; it does not release native stock ownership.

An account identifies tenant, canonical SKU, canonical location, unit and stock state. Physical
states are available, reserved, held, quarantine, damaged, returned awaiting inspection, incoming
and in transit. Virtual counterparties are supplier, customer, loss, adjustment and production,
plus one `external:<connection>` drift account per source. Virtual accounts retain an explicit
location context. Names and SKU text never merge stock pools. Units are exact decimals at the
canonical six-decimal precision; entries balance separately for each SKU and unit. No conversion
between units or variants is implicit. Bundles move component units; their merchandising parent
never creates a second stock balance. Assembly needs explicit production entries per component.

Each posted movement has at least two nonzero postings whose signed quantities sum to zero.
The database enforces balanced, tenant-consistent postings and immutable entry identity at commit.
A maintained account balance and monotonic version change atomically with the entry, audit and
publication. Physical available stock cannot go below zero through allocation; externally reported
negative quantities remain evidence and require explicit reconciliation. Virtual accounts can be
negative. Opening balances have an adjustment counterparty and reviewed source evidence.

Commands carry a stable tenant-scoped idempotency key, content hash, expected balances and
versions for every affected account. Reusing a key with different content fails; an identical
retry returns the original receipt before checking current balances. Lock affected account rows
in canonical sorted order, validate all expected versions and limits, and commit one short
transaction. Account creation uses the same identity ordering. A changed version fails stale;
never silently refresh an approved command or keep a database lock across provider requests.

Reservations are pending allocations from available to reserved, tied to exact order lines and
locations. Each fulfillment or release consumes an explicit remaining quantity exactly once,
using its own idempotent command. Partial fulfillment leaves the remainder pending. Expiry,
cancellation and final release contend on the same reservation version; a terminal reservation
cannot be consumed again. Dispatch consumes reserved units into the customer account only from
confirmed shipment facts; merely preparing work does not dispatch stock. Shortages and backorders
are separate unallocated demand, never invented negative reservations.

Posted entries cannot be edited or deleted. Corrections reference the original with opposite
postings, followed by a separately reviewed replacement when needed. A uniqueness constraint
prevents reversing the same entry twice. A reversal is still subject to current stock limits:
stock already consumed can require a compensating operation instead of an impossible reversal.
Ownership reversal is a separate audited transition, not a reversal of historical stock movements.

Every entry retains effective time (when the source says it happened, unknown when unstated) and
recorded time (when Luma committed it), together with actor, reason and evidence references.
A timestamp without business meaning cannot substitute for effective time. Periodic versioned
balance checkpoints accelerate queries, but postings remain the truth. Historical queries specify
both effective cutoff and knowledge cutoff; a later correction cannot rewrite what was known at
approval. Unknown effective times are reported separately. Aging uses known effective times or an
explicit recorded-time fallback and configurable thresholds. In-transit, inspection and drift
balances become detection candidates when they fail to drain; elapsed time alone does not prove loss.

Quantity and valuation are separate. Do not add cost of goods or statutory accounting to this
ledger. Preserve stable entry, account and line identities so later lot, batch, serial, buyer
authorization and invoice extensions can reference them. Do not store speculative dimensions or
personal payloads in immutable stock evidence. Dimension extensions must define their own balance
and uniqueness invariants before release.

## Source semantics and ownership

Shopify's `committed` is order-committed stock. Its separate `reserved` quantity is not the same
fact and neither alone defines Luma's reservations. Retain available, committed, reserved,
incoming, damaged, quality control, safety stock and on hand, plus location activity and item-level
activation, as separately reported nullable facts. Missing is unknown; never derive Shopify's
available quantity as on hand minus reserved. Source semantics are versioned with the adapter,
normalizer and snapshot schema; earlier snapshots remain readable with unknown added fields.
Incoming reports and transfer lines are context, not additional quantities to add to stock positions.

Ownership is per selected location and fact group, with a monotonically versioned transition
through observe, shadow, propose and own. Observe and shadow cannot dispatch ledger stock writes.
Shadow starts from reviewed opening balances, reconciles against fresh complete provider reads and
records unexplained differences in source-specific drift accounts. A changed authority, mapping or
opening balance invalidates a prepared cutover. Own requires deliberate approval and demonstrated
reconciliation; workspace-wide authority alone cannot silently cut over a location. Returning to
observe requires an audited handback with independently checked balances and pending effects.

Publishing channel availability uses Action Admission, exact persisted previews, approval, durable
claims and audit. It binds the ledger/reservation versions, selected location's ownership version,
channel buffer, mappings, source freshness and provider compare-and-set quantity. Storage does not
imply active or sellable stock; location activation and state moves require separate capabilities.
Independent fresh reads verify quantities and eligibility. Uncertain dispatches stay claimed and
are reconciled without blind replay. Shopify references must use its supported mutation reference
field with a stable Luma action identity. Exact references establish attribution only when the API
actually exposes them on independent reads. Quantity/time matches without a source reference are
lower-confidence candidates, including JTL and Cin7; they never prove origin or suppress a conflict.
A matching receipt never authorizes a new movement or establishes issue resolution.

## Alternatives and consequences

| Alternative                                          | Tradeoff                                                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event sourcing with stock projections                | Flexible replay, but adds projection lag, versioned event handlers and rebuild operations to a problem that needs atomic balance checks. Immutable postings already provide the needed history.           |
| Dedicated ledger database                            | Specialized throughput and invariants, but introduces another isolation, deployment and transaction boundary. It cannot atomically combine existing Inventory ownership, tenant RLS, audit and admission. |
| Provider stock remains authoritative with drift only | Appropriate for observe mode, but cannot safely accept native reservations or fulfill merchant-owned stock without a provider transaction. Keep this mode during shadow.                                  |
| Defer the model until merchant demand                | Avoids implementation cost but leaves order, bundle and return contracts without allocation semantics. Decide the contract now; gate operational ownership on merchant evidence.                          |

PostgreSQL keeps one owner transaction and existing isolation controls. Busy accounts serialize
reservations: keep transactions short, bound lock waits, surface stale review failures and measure
contention before expanding a merchant workload. Multiple distinct SKUs can proceed concurrently.
Do not introduce a queue or dedicated ledger service without measured capacity pressure.

Reversal cost is exporting retained postings, account identities, reservation receipts and both
times, then reconciling physical and channel balances under audited handback. A replacement store
must preserve idempotency receipts and unsettled effects. Disabling a flag cannot erase ownership
or pending reservations. Contention evidence and follow-up scope belong in Linear and review artifacts.
