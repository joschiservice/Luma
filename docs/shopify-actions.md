# Shopify actions

The Shopify app offers governed writes for **returns**, **fulfillment recovery** (release a hold,
reopen, or move remaining items), **inventory corrections** (set Shopify's available
quantity from a selected JTL ERP source) and **order quantity edits** (change quantities of
unfulfilled order lines), and **shipment publishing** (record an independently observed physical
dispatch or update its tracking). They run as exact, persisted previews that
someone with approval permission approves under the [workspace rules](workspace-settings.md#approval-preference), dispatch through shared policy, audit, Action Admission and
execution, and count as done only after an independent Shopify read verifies the outcome.
Code: `@luma/app-shopify`.

## Shared rules

**Preview and approval.**

- A preview binds the exact connection, source records, revision or quantities, and the
  chosen option. Only a saved preview ID enters execution; no client-supplied quantity,
  destination or model output can bypass these controls.
- The requester and approver must be different people. Both need the action's app
  permission; the approver also needs `decisions.respond`.
- A preview stays open for a four-hour decision window.
- Before dispatch, Luma reads Shopify again and rechecks membership, installation, grants,
  source revision or quantities, mappings and eligibility on that read.

**Claims and retries.**

- A transactional claim serializes actions per target, so concurrent previews cannot both
  act on it.
- A durable acceptance or a confirmed withheld write releases the target claim. Uncertain
  attempts keep it until reconciled.
- Reloads, retries and reconstructed runtimes reuse the original proposal and never resend
  a reserved mutation. Reconciliation and verification only read Shopify.
- Previews, claims, allowlisted evidence and acceptance receipts are stored under forced
  tenant RLS.

**Acceptance is not resolution.** A mutation receipt means Shopify accepted the request.
Verification needs a fresh, complete read showing the expected outcome; anything else
stays unverified, and the operator can inspect Shopify or check again. Luma never closes
an operational issue or rewrites canonical snapshots from a receipt; data sync and the
issue monitor own those updates.

**Access.** Reauthorization requests the write scopes (`write_inventory`,
`write_merchant_managed_fulfillment_orders`, `write_third_party_fulfillment_orders`,
`write_order_edits`). Connections authorized before a scope existed stay usable for reads but
cannot run the actions it covers until they reconnect.

[Needs you](needs-you.md) lists previews awaiting approval, approved actions waiting for
their requester, and accepted or uncertain actions without verified results, through the
app's `fulfillment`, `inventory` and `record` (order) UI slots.

## Fulfillment recovery

Permission: `shopify:fulfillment_recovery.run`. Available on open fulfillment orders when
Shopify reports the action as supported, all lines were read completely and, for moves,
eligible locations exist. Claims cover each fulfillment order and its revision. Releasing
the fulfillment order's claim keeps the revision claim, so one revision never carries a
second action.

- Shopify exposes no compare-and-swap argument on these mutations. Luma rechecks
  immediately before dispatch; Shopify remains the final authority on eligibility.
- A hold release always names exactly one hold.
- A move omits a line subset and therefore moves all remaining items. The destination
  must support every remaining line; truncated reads and approximate unavailable-line
  counts cannot authorize a move.
- Verification requires a fresh complete read of the same fulfillment order with
  unchanged line identities and totals, and fewer remaining units. Changed identities
  after a move, cancellations, partial reads and unchanged quantities stay unverified.

## Inventory corrections

Known bundle parents are ineligible for an independent stock correction. A fresh read of
the variant flag and recipe membership requires native product read access. Unreadable
metadata prevents dispatch; catalog context alone never authorizes a write.

Permission: `shopify:inventory_corrections.apply`. Luma supports one source-of-truth
policy: a JTL ERP source the requester selects supplies the available quantity, and
Shopify is the destination. Luma never writes ERP stock, accepts a manually entered
quantity, sums sources, applies deltas, or treats a source as authoritative merely
because its quantity differs. JTL remains a read-only reference.

- Both sources must be active, installed, readable and mapped to the same canonical SKU,
  location and `each` unit, each with exactly one unscoped SKU and location mapping.
  Shopify needs real InventoryItem and Location IDs, tracked inventory and an active
  location with an active inventory level for that item.
- The ERP quantity must be a known, nonnegative integer, and its evidence must be under
  five minutes old when Luma judges it. Every read of the target, including the final
  check before the write, first rereads stale stock sources, so a late approval acts on
  current stock. If the reread changes the correction, the preview no longer runs and a
  new one needs a new approval. A source that cannot be reread keeps its stored report,
  and stale evidence still stops the write.
- The claim covers the exact Shopify item and location, including across canonical
  mapping changes.
- The mutation sets the quantity with an exact `changeFromQuantity` and an idempotency
  key. Do not bypass that compare-and-swap: Shopify rejects any concurrent change to the
  available quantity, including one after Luma's final read.
- A correction uses a stable `referenceDocumentUri` derived from the persisted execution
  key. Acceptance retains the exact Shopify adjustment ID, URI and quantity change. Sync
  and verification independently read that adjustment, filtered to the exact item,
  location and available state. Missing, changed or ambiguous references leave authorship
  unknown. New correction verification requires both that proof and the fresh quantity;
  older previews retain their original quantity-only verification contract.
- Inventory shows the corroborated correction separately from the latest quantity.
  A match never proves exclusive authorship; a residual difference remains eligible for
  detection, including when another app changes stock after Luma's write. Proof scans are
  bounded to twenty recent targets per read and seven days of receipts. Older or omitted
  targets keep usable quantity evidence with unknown cause. Uncertain writes without a
  durable receipt are not attributed or replayed from a timing or quantity match.
- Verification reads Shopify independently and requires the approved quantity at the
  same item and location, complete tracked inventory and unchanged ERP authority. A
  changed ERP quantity, availability or mapping leaves it unverified. A newer ERP read
  with the same values is not a change, so detection's frequent rereads do not invalidate
  a reviewed correction; its expiry still follows the reviewed read.

### Providers without adjustment references

JTL and Cin7 stock reads do not expose this adjustment reference. A time-window and quantity
match can support a low-confidence investigation candidate, but cannot confirm a Luma echo,
close an issue, suppress a difference or authorize a retry. Their current stock integrations
remain read-only; no heuristic is promoted to verified authorship.

## Order quantity edits

Permission: `shopify:order_edits.apply`; capability `orders.quantity.edit`, granted only with
`write_order_edits` and a fulfillment read scope. Order detail and the app's record browser
offer the edit for a single Shopify order. An order change plan's Luma step opens it
prefilled with the planned quantities; the preview, approval and checks below still apply. One edit changes up to 20 existing lines to whole, nonnegative quantities and
may restock removed units. Luma never adds products or changes prices, discounts or shipping.

- Every changed line must be unstarted: no fulfilled unit, and every fulfillment order with
  its remaining units `OPEN`, `SCHEDULED` or `ON_HOLD` and never submitted to a fulfillment
  service (`UNSUBMITTED`). Held work is allowed and shown. In-progress, incomplete,
  requested or unrecognized work, remaining units that differ from Shopify's unfulfilled
  count, and a read truncated at 100 lines or 5 fulfillment orders all block the edit.
  Cancelled and closed orders cannot be edited.
- Workspace line authority must resolve. When this store holds it, the edit amends the
  authoritative record. When another connection holds it (JTL-Wawi, or Luma ERP), the edit
  may only propagate that source's value: every changed line's new quantity must equal the
  current units the authoritative source reports for the same line, matched by shared
  canonical line ID or a mapped SKU that occurs once per source, as order comparisons match
  lines. That source's stored read must be complete and at most five minutes old, the same
  freshness as comparisons; an older, future or incomplete read blocks as stale. A stored
  read older than a minute is first reread through the [order refresh](orders-workspace.md#refreshing-an-orders-sources),
  so a late approval still dispatches on current values. Luma ERP holds authority here only
  while the workspace's Luma order records are released. A host
  without an authority reader or stored order reads, unknown or conflicting authority, or a
  changed authority revision blocks the edit.
- A preview binds the order revision (a digest of Shopify's `updatedAt` and every fact
  above, because `updatedAt` has second precision), each line's reviewed and approved
  quantity, the restock choice, the authority revision, for a propagated edit the
  authoritative source's connection, snapshot, observation and read time, and Shopify's
  calculation. Luma
  calculates with `orderEditBegin` and `orderEditSetQuantity` and never commits that
  session; an abandoned session changes nothing. The preview binds the read taken after
  calculating and is refused if the edit facts changed meanwhile.
- Observe-only previews send nothing, not even the calculation. They show the money
  consequences as not calculated and cannot run after writes are enabled; a new preview
  and approval are needed.
- Before the commit, Luma reads the order again, rechecks every rule (for a propagated edit,
  that the same source still holds authority and a fresh, complete read still reports the
  approved quantities), recalculates in a new
  session and withholds the edit when quantities or money differ from the approved
  calculation.

Shopify has no idempotency key for order edits. Luma records a durable fence for each
operation: `reserved` before calculating, `sent` immediately before `orderEditCommit`, then
`accepted`, `rejected` or `withheld`. The commit is sent at most once per operation, with
`notifyCustomer: false` and the staff note `luma-oe:<operation UUID>`. A claim per order
and per revision keeps a second edit away until the first settles.

A lost commit response stays uncertain and keeps the claim. Reconciliation reads the
order's recent edit agreements and line quantities; it never resends the commit. The edit
was applied when exactly one `ORDER_EDIT` agreement by Luma's app since the commit carries
product sales matching every approved change and the lines show the approved quantities.
It was not applied when the operation never reached `sent`, which reconciliation fences
permanently, or when ten minutes after sending no agreement by Luma's app exists and the
lines still show the reviewed quantities. Not applied ends the operation; a new edit needs a
new approval. Anything else stays uncertain. Shopify does not document the sign of removed
units in sales, so the sale's action (`RETURN` or `ORDER`) decides the direction.

Verification needs a fresh complete read of the open order with every approved line at its
approved quantity and Luma's matching edit agreement. Partial reads, later changes to the
lines and merchant edits stay unverified. An accepted edit also asks data sync to read the
connection's orders again; Luma never writes order projections from the receipt.

## Returns

Permission: `shopify:returns.manage`, together with `returns.manage` for case commands.
The connection needs `write_returns` and order reads; reconnect older connections to grant
creation and the independent lookup capabilities. Shopify remains the authority on whether
fulfilled, unrefunded items are eligible. Creation uses `returnCreate`; a case linked to a
customer request uses `returnApproveRequest` for its exact source ID, lines and quantities.
These operations neither refund money nor report physical receipt or restocking.

The shared return-case action fixes source order lines, quantities and reason, asks for
approval and dispatches once through Action Admission. The 24-hour case request window
applies. Creation requires one unambiguous fulfillment-line mapping per order line; split
shipments require an explicit allocation and are refused. Lookup reads at most five returns
with twenty lines each. Any overflow blocks dispatch or verification rather than treating a
truncated collection as complete.

Shopify has no creation idempotency key in the pinned API. Every created line carries the
exact machine marker `luma-rc:<case UUID>` in its reason note. Reconciliation reads the order
independently, requires the marker on every line of exactly one open return, and checks the
approved total units per order line. Unrelated customer notes are discarded before evidence
is recorded. A missing, changed or duplicated marker never permits replay; the case keeps
its uncertain creation slot. Approval reconciles by the exact existing return ID and open
state. Acceptance alone never means the case is resolved.

### Case refunds

Refund settlement needs `write_orders`, independent order reads and `shopify:returns.manage`.
The approved plan comes from `Order.suggestedRefund` for received units. Luma sends `refundCreate`
with the operation UUID as its native `@idempotent` key, captured parent transactions, notifications
off and `NO_RESTOCK` on every line. Stock is a separate case action. A changed quote blocks dispatch.

Proof independently scans at most 100 refund identities, then 20 lines and 20 transactions for the matching refund. At a bound,
uniqueness or completeness is unknown. It requires exactly one machine operation marker, the approved
lines and successful payment transactions in the approved currency. Notes unrelated to the marker
are discarded. Pending or failed payment remains explicit and never triggers another refund.

### Case exchanges

Exchange reads require order, returns, product and inventory access. Native request, process and
cancellation need `write_returns`; payment hold release also needs the applicable fulfillment write
scope. Every write uses `shopify:returns.manage` and its own independent high-risk approval.

`returnCreate` includes an exchange line and explicitly sets the transitional `unprocessed` flag.
Request approval must not also process the replacement. `returnProcess` uses exact processable return
and exchange line IDs and Shopify's suggested financial transfer. Refund differences use original
captured parent transactions with over-refunding disabled. Processing does not restock returned goods.

These mutations have no claimed provider idempotency guarantee. Each line retains the exact marker
`luma-ex:<operation UUID>:<attempt UUID>`. One-shot dispatch and permanent sent fencing survive restart;
independent reads verify the marker, quantities, native processed lines and exactly one corresponding
fulfillment. Payment verification remains separate. Cancellation is limited to the exact unprocessed
intent; hold release removes only its independently observed awaiting-payment hold. Truncated source
collections, changed mappings, unexpected transactions and unavailable reads leave work unverified.

## Shipment publishing

Permission: `shopify:shipment_publishing.run`. Shopify needs order and fulfillment reads
and an applicable merchant-managed or third-party fulfillment write scope. The server
checks the workspace release flag before preview eligibility and again immediately before
the send; an unavailable flag reader keeps publishing disabled.

A fresh, complete downstream read must show carrier dispatch or delivery, with explicit
tracking identity. A printed label, pickup request or accepted warehouse task is never
physical dispatch evidence. The downstream connection must remain installed and readable.
Read evidence must be at most five minutes old and must not come from the future.

The exact preview binds the downstream parcel, its revision, Shopify order, fulfillment
order lines, quantities, warehouse, tracking and an explicit customer notification choice.
Partial publishing sends only the selected fulfillment-order lines; it never omits a line
subset and accidentally fulfills all remaining units. Shopify work must be open or in
progress, unsubmitted to a fulfillment service, and support creation. Cancelled orders,
changed quantities, holds and warehouse changes prevent sending. No carrier shipment or
label is created by this action.

When a downstream provider identifies the parcel's items and warehouse, Luma requires
exact canonical line and location mappings. Provider-reported quantities cannot be
overridden. Starshipit's tracking endpoint does not always identify items or warehouse
per parcel. In that case, the requester explicitly confirms the exact allocation against
the warehouse dispatch record. This operator allocation is saved in the same immutable
preview and shown to the approver; it is never presented as provider evidence. Split
parcels require their own allocations and approvals.

A durable claim covers the physical downstream parcel, independent of the preview's
quantities or Shopify revision. Another claim serializes writes for the Shopify order.
The send fence is persisted before the native mutation, and neither retries nor runtime
reconstruction resend it. Unknown outcomes retain the order claim. Tracking updates bind
one existing Shopify fulfillment, its exact line allocation and the notification choice;
a parcel's tracking lineage cannot move to a different fulfillment.

Reconciliation only reads Shopify. Creation is verified when exactly one new successful
fulfillment has the reviewed allocation, location and complete tracking identities.
Tracking updates verify those facts on the exact existing fulfillment. Acceptance alone
is unverified; missing, changed, duplicate, cancelled or incomplete evidence remains
unverified without a replay. Notification preferences are recorded in the preview and
audit; Shopify's fulfillment read does not independently prove email delivery.

Shopify reads are bounded to five fulfillment orders with twenty lines each and fewer
than five shipments with twenty lines and twenty tracking identities each. A collection
truncated at any bound prevents eligibility or verification. These limits keep the review
within Shopify's synchronous query budget; larger orders need review directly in Shopify.
