# Shopify inventory corrections

Inventory offers one bounded source-of-truth policy: a selected JTL ERP source
supplies the available quantity, and Shopify is the correction destination. Luma
never writes ERP stock, accepts a manually entered quantity, sums sources, or
assumes that a source is authoritative merely because its quantity differs.
The requester selects the ERP authority; someone else with `decisions.respond` and `shopify:inventory_corrections.apply` approves the
exact persisted proposal. Other source-of-truth policies and delta adjustments
are unsupported.

Both sources must be active, installed, readable, and mapped to the same canonical
SKU, location and `each` unit. Every source must have exactly one unscoped SKU and
location mapping. Shopify requires real InventoryItem and Location IDs, tracked
inventory and an active location. The ERP quantity must be a known, nonnegative
integer, and evidence must be less than five minutes old when Luma judges it. A
preview stays open for a four-hour decision window. Each read of the target,
including the check right before the write, first rereads stale stock sources
through the host's `refreshStock` (`createStockRefreshService`), so a late
approval acts on current stock. When the reread changes the correction, the
preview no longer runs and a new one needs a new approval. A source that can't
be reread keeps its stored report, and stale evidence still stops the write.

The app-owned service in `packages/apps/shopify/src/application/inventory-correction.ts`
uses shared policy, audit, Action Admission and execution. Membership, installation,
grants, source quantity, observation identity and mappings are checked again before
dispatch. The only input to execution is a saved correction ID. No model output or
client-supplied quantity can bypass the same controls.

The Shopify 2026-07 mutation uses `inventorySetQuantities` with an exact
`changeFromQuantity` and `@idempotent` key. Luma does not bypass the compare-and-swap
check. Shopify rejects a concurrent available-quantity change, including one after
Luma's final read. Reauthorization requests `write_inventory`; existing read-only
connections remain usable but cannot correct stock. JTL remains a read-only reference.

Migration `0043_shopify_inventory_corrections.sql` stores previews, claims and
allowlisted evidence with forced tenant RLS. A transactional claim serializes each
exact Shopify item/location, including across canonical mapping changes. Accepted
or confirmed withheld writes release the target claim. Uncertain attempts keep it.
Retries and reconstructed runtimes reuse the same proposal. Verification never
resends a mutation. Shopify simulator receipts persist with the provider state.

A successful receipt is acceptance, not resolution. Reconciliation independently
reads Shopify and requires the approved quantity at the same item and location,
complete tracked inventory and unchanged ERP authority. A changed ERP quantity,
availability or mapping leaves reconciliation unverified. A newer ERP read that
reports the same values is not a change, so detection's frequent rereads don't
invalidate a reviewed correction; its expiry still follows the reviewed read. Luma records verification evidence and
shows **Quantity verified**; it does not optimistically rewrite canonical snapshots
or close related operational issues. Data sync and the independent issue monitor
retain ownership of those updates.

Pending approvals, approved corrections waiting for their requester, and accepted or
uncertain corrections without a verified quantity also appear in [Needs you](needs-you.md),
which mounts the same `inventory` slot.

Entry points are Inventory's stock detail, the app's `inventory` UI slot, and
`inventory-correction-{candidates,inspect,preview,approve,execute,check}` commands.
Validation: Shopify provider unit tests, simulator CAS/idempotency tests,
`shopify-inventory.e2e.mjs`, `shopify-inventory.browser.mjs`, and the
**Inventory / Shopify stock correction** stories.
