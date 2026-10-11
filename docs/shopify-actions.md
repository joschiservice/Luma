# Shopify actions

The Shopify app offers two governed writes: **fulfillment recovery** (release a hold,
reopen, or move remaining items) and **inventory corrections** (set Shopify's available
quantity from a selected JTL ERP source). Both run as exact, persisted previews that
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
`write_merchant_managed_fulfillment_orders`, `write_third_party_fulfillment_orders`).
Connections authorized before that stay usable for reads but cannot run these actions
until they reconnect.

[Needs you](needs-you.md) lists previews awaiting approval, approved actions waiting for
their requester, and accepted or uncertain actions without verified results, through the
app's `fulfillment` and `inventory` UI slots.

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

Permission: `shopify:inventory_corrections.apply`. Luma supports one source-of-truth
policy: a JTL ERP source the requester selects supplies the available quantity, and
Shopify is the destination. Luma never writes ERP stock, accepts a manually entered
quantity, sums sources, applies deltas, or treats a source as authoritative merely
because its quantity differs. JTL remains a read-only reference.

- Both sources must be active, installed, readable and mapped to the same canonical SKU,
  location and `each` unit, each with exactly one unscoped SKU and location mapping.
  Shopify needs real InventoryItem and Location IDs, tracked inventory and an active
  location.
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
- Verification reads Shopify independently and requires the approved quantity at the
  same item and location, complete tracked inventory and unchanged ERP authority. A
  changed ERP quantity, availability or mapping leaves it unverified. A newer ERP read
  with the same values is not a change, so detection's frequent rereads do not invalidate
  a reviewed correction; its expiry still follows the reviewed read.
