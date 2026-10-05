# Canonical commerce projections

`createCommerceServices(databaseUrl)` wires the connector source store, orders and
inventory owners, and the commerce ingestion workflow. Call it with a restricted
login inheriting `luma_connectors`, `luma_orders` and `luma_inventory`. Close the
service when its worker stops. All methods require a resolved tenant context;
ingestion and mapping require an owner or admin.

## Ingest and reconcile

1. Pass an `orders.read`, `inventory.read`, `fulfillment.read` or `returns.read` observation to
   `ingestion.ingest(context, ingestKey, input)`. Use a stable poll-run/page/item or
   provider event key on retries. A new poll uses a new key. The connection must
   belong to the tenant and be active or degraded.
2. Missing source mappings return `pending` with the missing identities. The
   validated observation remains stored, including its adapter version, source
   revision, source time and observation time.
3. Use `ingestion.bind(context, source, reconciliationKey, observationId, method)`
   to establish an evidenced equivalence. The source object must occur in the
   referenced observation. Reuse a reconciliation key only for objects confirmed
   to represent the same entity. Keys are scoped by tenant and entity kind.
   Fulfillment keys also include the connection, preserving mirrored operations.
4. Call `ingestion.replay(context, connectionId, ingestKey)` after resolving missing
   mappings or recovering from an interrupted ingestion. Owner transactions are
   idempotent. No distributed transaction spans connectors and commerce owners.
5. Read `orders.current/history` or `inventory.current/history` by canonical ID.
   Current results include the snapshot ID, projection version, connection and
   immutable provenance. Inventory positions group equivalent SKU, location and
   unit identities while preserving each connection's quantities.

External IDs remain case-preserved strings, including leading zeros and parent
scope. Display numbers and SKU text do not establish equivalence. A conflicting
binding is rejected; mappings retain the confirming actor, method and observation
as immutable audit evidence. Corrections require a separately reviewed remapping
operation rather than overwriting history.

## Imports, products and links

`ingestion.import(context, ingestKey, input)` is the history-import path. It records
the observation, binds every unmapped identity it carries to its own canonical
entity (`sourceLocalKey`, method `Imported source record…`) and projects. Existing
mappings, including operator mappings made before the import, are reused. Imports
never merge records across connections; SKU text and display numbers stay descriptive.

`products.read` observations project as inventory `product` snapshots with their
variant SKUs. Product snapshots are version 2 (normalizer `commerce/2`) and may carry
vendor, sales channel publication and, per SKU, variant title, list price and barcode.
A price's currency is null when the source reports none; such prices are never compared.
Version 1 product documents stay valid. `inventory_product_skus` holds one row per current
product and SKU with the SKU's normalized source code, which labels SKUs and suggests
links, and the listing facts the [Products workspace](products-workspace.md) compares.
Inventory rewrites these rows with the projection pointer (migration `0043`).

`ingestion.link(context, kind, targetId, otherId, reason)` confirms that another SKU,
location or order is the same record. Every mapping of the other entity moves to the
target through `sources.remap`, which appends a `connector_mapping_revisions` row;
a trigger rejects mapping changes without one. Stock positions, product snapshots
and order lines that still refer to the other entity are replayed from their stored
observations, and positions that moved are retired (`inventory_projection_retirements`),
keeping their snapshots as history. `unlink` moves one connection's source back to its
own entity and replays the same way. Both operations are idempotent: repeating them
finishes any remaining replay. Two entities that share a connection cannot be linked.

Order links re-key each source child under the order mapping revision before replay. New
lines, fulfillments, returns and refunds use that same generation. The immutable parent guard
still rejects children bound to an unrelated order. Orders-owned retirements remove old current
pointers and maintain redirects; snapshots remain immutable. Unlink restores a source-local
order with another child generation. Runtime ingestion, including link/unlink, shares a tenant
transaction and lock, so partial remappings are not visible to concurrent imports or reads.

A replay can return to a snapshot that already exists, for example after unlinking.
The owner then makes that snapshot current again when it re-normalizes the current
observation or when the source's projection was retired, and returns `applied`.

## Returns and refunds

`returns.read` observations carry a `return` or a `refund` (resource and `data.type` agree).
Both project as orders-owner children of their order, with per-connection identities like
fulfillments. Return lines refer to canonical order lines of the same connection, or to none
for items the source did not tie to an order line; refund lines always refer to one. A
refund's `returnId` must belong to the same order. Both use schema version 1 and normalizer
`commerce/1`. The owner derives each return's stage and refund state and rebuilds the
order's `orders_returns` rows in the projection transaction; see
[Returns workspace](returns-workspace.md).

## Projection rules

Order snapshots can also carry `dueAt`, `placedAt`, a source `total` with its
currency, and line `skuCode` and `title`. These are descriptive source facts: SKU
text never establishes SKU identity, and totals are never converted between
currencies. They are optional; absent means the adapter did not report the fact.
An existing order gains them when a snapshot carrying them becomes current under
the ordering rules below.

Only complete normalized object snapshots or explicit tombstones are accepted.
Partial collection pages can supply complete individual objects; missing items in
those pages never delete stored entities. Required nulls distinguish unknown
values from omitted fields. Order lines can retain an unknown SKU or cancelled
quantity. Inventory values retain null, zero, negative and fractional quantities
without deriving or summing stock across sources.

Each source has its own current snapshot. An incoming snapshot replaces it when:

- it re-normalizes the current snapshot's observation, for example after a new
  SKU mapping or normalizer version;
- both snapshots carry a source update time and the incoming one is newer;
- the source update times are equal or at least one is missing, and the incoming
  observation time is later. Equal update times occur when a provider reports
  whole seconds, as Shopify does, and a record changes twice within one second; or
- both observation times are also equal and the greater observation ID wins,
  unless exactly one snapshot has a source update time.

Every other snapshot remains historical evidence and returns `retained`. Receipt
time and opaque revisions never establish order. A source update time is never
compared with an observation time, because they come from different clocks.
Tombstones follow the same rules, preventing stale resurrection. `duplicate` means
the immutable snapshot already exists, even when it was previously retained rather
than selected.

Sources that report no update time, such as JTL sales orders and delivery notes,
therefore advance with each later read. This relies on the adapter contract:
`observedAt` is when a point-in-time read started, taken on Luma's clock before
the request, and one connection's reads of a resource do not overlap. A late or
replayed older read cannot replace a later one, and the same set of untimed reads
settles on the same current snapshot in any arrival order. When an adapter starts
or stops reporting update times, the transition is ordered by observation time.

## Versioning

Snapshot identity is `(entity, observation, normalizerVersion, mappingVersion)`.
Replaying an observation under the same identity must produce the identical
document; otherwise projection fails with `Snapshot identity conflict`.

- Bump the adapter version (`jtl/1`, `shopify/1`) whenever the same provider
  response would normalize to different observation data, including added
  optional fields. Observation provenance then shows which adapter produced each
  fact. Capability dispatch identities include the adapter version, so writes
  started under an earlier version cannot be reconciled by the new one and need
  operator review.
- Bump the canonical `schemaVersion` of a snapshot kind when its document shape
  changes, including added optional fields. Order snapshots are version 2 and
  may carry `dueAt`, `placedAt`, `total` and line `skuCode`/`title`. Stored
  version 1 order documents stay valid and readable; they may already carry some
  of these fields. Product snapshots are version 2 and may carry listing facts.
  Fulfillment snapshots are version 2 (normalizer `commerce/2`) and may carry kind,
  holds, location, `fulfillAt`, `fulfillBy`, estimated delivery, delivery method,
  tracking and carrier delivery state. Position snapshots are version 1.
- Bump the normalizer version (`commerce/2` for orders) whenever the canonical
  document for an existing observation changes. Replay then stores a new snapshot
  beside the old one instead of conflicting with it.

A fulfillment's location is an optional reference, like an order line's SKU: an unmapped
source location stores its name with a null `locationId`, and linking locations replays the
fulfillments assigned to them (`orders.locationDependents`). The orders owner keeps one
`orders_fulfillment_list` row per current fulfillment projection with these facts in plain
columns (migration `0044`), rewritten with the projection pointer; see the
[Fulfillment workspace](fulfillment-workspace.md).

Order lines and fulfillments have immutable canonical parent bindings. Fulfillment
lines must occur in the same connection's order projection and use its units.
Split operations stay separate; quantities are not clamped to the ordered amount.
The owner validates these relationships again inside its transaction.

## Persistence and authority

Migration `0007` uses owner-prefixed entity, snapshot and projection tables.
Canonical identities have indexed reconciliation keys. Validated versioned
snapshots retain normalized order/fulfillment lines; generated SQL columns expose
order statuses, display numbers, parent IDs and exact inventory quantities for
indexed queries. Composite keys and forced RLS protect tenant and source scope.
Migration `0008` requires every snapshot to reference a stored observation in the
same tenant and connection. Invalid provenance rolls back the snapshot and its
publication. Existing tenant/observation indexes support these foreign keys.
Restricted roles cannot update or delete observations, mappings or snapshots.
The projection pointer, immutable snapshot and append-only publication event commit
together. Snapshots include a mapping signature, so resolving a previously unknown
SKU creates a new canonical snapshot without changing the original evidence.

These are per-source projections, not a cross-source authority selection. Consumers
must explicitly select a source. The detection configuration continues to own
comparison authority; these reads do not authorize corrections. ADR-002's future
field-group authority publication and remapping workflow are not activated by this
storage layer. Raw provider payloads are not retained, and observations never carry
customer or address data; imported customer profiles are stored separately (see
[Commerce sync](commerce-sync.md#customers)).

`commerce.integration.test.ts` runs against PostgreSQL with restricted credentials.
It covers pending/replay, concurrent delivery, immutable conflicts, isolation,
source disagreements, timestamps, sources without update times, version 1 order
snapshots, tombstones, decimal precision, split shipments, and parent/unit
validation.
