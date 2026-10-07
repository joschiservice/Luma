# Inventory workspace

Inventory groups current canonical stock projections by SKU, location and unit. Each
connection keeps its own quantities: no source is implicitly authoritative and quantities
are never summed across sources.

Code: `@luma/read-models` (reads), `inventory` API contract. Reads use tenant transactions
and existing read grants.

## Rules

- Known decimal quantities are compared at their canonical six-decimal precision. Missing
  values never become zero.
- Removed snapshots remain visible as provenance but do not participate in comparisons.
- Observation time, source update time, connection status and reported versus derived
  availability remain separate facts.
- Source filters select positions without hiding their other sources. Lists use 50-position
  keyset pages; cursors belong to the tenant and filters that produced them.
- SKUs are labeled with a source SKU code from the product catalog when one is known,
  otherwise with the canonical key. `skuKey` keeps the canonical key that purchase orders
  and replenishment use.

## Detail

The detail read includes up to 100 observed snapshots and 50 entries per related record
type. Order lines use canonical SKU relationships and retain source and unit. Purchase
orders match the canonical SKU ID or reconciliation key. They are commitments, not
confirmed receipts or incoming stock; the model has no receipt progress or location
allocation. Provider incoming quantities are not in the canonical projections and are
shown as unknown.

Linking or unlinking matching SKUs from other sources requires `sync.manage`.

## Corrections

People with `shopify:inventory_corrections.apply` can review an ERP-backed Shopify
available-stock correction from stock detail. A different administrator approves the exact
source, location and quantity. Writes require fresh evidence, unambiguous mappings and
inventory write access. Acceptance and independently verified stock remain separate
states; see [Shopify inventory corrections](shopify-actions.md#inventory-corrections).
