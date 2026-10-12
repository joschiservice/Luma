# Canonical commerce projections

Commerce ingestion turns validated provider observations into immutable, per-source
canonical snapshots of orders, fulfillments, returns, refunds, products and stock
positions. Every snapshot points to the stored observation it came from, and equivalence
between source records is established only by explicit, evidenced mappings. These are
per-source projections, not an authority selection: display consumers choose a source, while the shared Connections authority reader
resolves workspace authority for compared order and inventory fact groups.

Code: `@luma/commerce-ingestion`, with the `@luma/orders` and `@luma/inventory` owners,
composed by `createCommerceServices` in `@luma/application-runtime`. Run it with a
restricted login inheriting `luma_connectors`, `luma_orders` and `luma_inventory`. All
methods require a resolved tenant context; ingestion and mapping require `sync.manage`.

## Ingest and reconcile

- Ingest keys must be stable across retries of the same poll-run/page/item or provider
  event; a new poll uses a new key. The connection must belong to the tenant and be
  active or degraded.
- An observation with unmapped source identities is stored and returns `pending` with
  the missing identities. Bind them, then replay the ingest key. Replay is also the
  recovery path after an interrupted ingestion: owner transactions are idempotent, and no
  distributed transaction spans connectors and commerce owners.
- A binding must cite an observation in which the source object occurs. Reuse a
  reconciliation key only for objects confirmed to be the same entity. Keys are scoped by
  tenant and entity kind; fulfillment keys also include the connection, so mirrored
  operations stay separate.
- Current reads return the snapshot ID, projection version, connection and immutable
  provenance. Inventory positions group equivalent SKU, location and unit identities while
  keeping each connection's quantities.

External IDs are case-preserved strings, including leading zeros and parent scope.
Display numbers and SKU text alone never establish equivalence. Configured
[automatic linking rules](commerce-sync.md#links) may establish identity from unambiguous,
current evidence between selected connections. A conflicting binding is
rejected; mappings keep the confirming actor, method and observation as immutable audit
evidence. Corrections go through an evidenced remapping (link/unlink), never by overwriting
history.

## Imports, products and links

History imports (`import`, `importMany`) record observations, bind every unmapped
identity to its own source-local canonical entity and project the records in input order,
all in one transaction. Any failure rolls back the whole batch. Existing mappings,
including operator and automatic mappings made before the import, are reused. Imports never merge
records across connections.

Owners create entities and mappings with sorted multi-row writes and lock affected order
and inventory entities in sorted order, so concurrent overlapping batches wait instead
of deadlocking. Keep that ordering when adding owner writes.

`products.read` observations project as inventory `product` snapshots with their variant
SKUs and listing facts. A price whose source reports no currency has a null currency and
is never compared. Inventory keeps one row per current product and SKU, rewritten with
the projection pointer, holding the SKU's normalized source code (which labels SKUs and
drives link suggestions) and the facts the [Products workspace](products-workspace.md)
compares.

Linking confirms that another SKU, location or order is the same record:

- Every mapping of the other entity moves to the target through a remap that appends a
  mapping revision; the database rejects mapping changes without one.
- Positions, product snapshots, order lines and fulfillments that referred to the other
  entity are replayed from their stored observations. Moved positions and order pointers
  are retired; their snapshots remain as history, and orders keep redirects for old IDs.
- Order links re-key each source child (lines, fulfillments, returns, refunds) under the
  new order mapping revision. The immutable parent guard still rejects children bound to
  an unrelated order. Unlink restores a source-local order with another child generation.
- Unlink moves one connection's source back to its own entity and replays the same way.
- Both are idempotent: repeating one finishes any remaining replay. Two entities that
  share a connection cannot be linked.

Imports and replays hold the tenant's ingestion lock shared; link and unlink hold it
exclusively, so partial remappings are never visible to concurrent imports or reads.

A replay can return to a snapshot that already exists, for example after unlinking. The
owner makes it current again when it re-normalizes the current observation or the
source's projection was retired, and returns `applied`.

## Returns and refunds

`returns.read` observations carry a `return` or a `refund`. Both project as orders-owned
children of their order with per-connection identities, like fulfillments. Return lines
refer to canonical order lines of the same connection, or to none when the source did not
tie the item to an order line; refund lines always refer to one. A refund's return must
belong to the same order. The owner derives each return's stage and refund state in the
projection transaction; see the [Returns workspace](returns-workspace.md).

## Projection rules

Only complete normalized object snapshots or explicit tombstones are accepted. Partial
collection pages can supply complete individual objects, but missing items never delete
stored entities. Required nulls distinguish unknown values from omitted fields: order
lines can keep an unknown SKU or cancelled quantity, and inventory keeps null, zero,
negative and fractional quantities without deriving or summing stock across sources.

Optional descriptive order facts (`dueAt`, `placedAt`, source `total`, line SKU text and
title) mean the adapter reported them; absent means it did not. SKU text never
establishes identity, and totals are never converted between currencies.

Order line `quantity` keeps originally ordered units. Optional `currentQuantity` reports
units still on the order, excluding removals and refunds; `cancelledQuantity` carries the
reduction when known, without identifying its cause. Fulfillment lines retain total units
and optional provider-reported `remainingQuantity`. Absent or null facts stay unknown.
Shopify reports both quantities; JTL ERP 2.2 exposes no per-line cancellation quantity,
so JTL cancellations stay unknown. Quantity edits create new snapshots and never rewrite
the prior evidence. Order and fulfillment schema versions 1 and 2 remain readable.

Each source has its own current snapshot. An incoming snapshot replaces it when:

- it re-normalizes the current snapshot's observation, for example after a new mapping
  or normalizer version;
- both carry a source update time and the incoming one is newer;
- the update times are equal or at least one is missing, and the incoming observation
  time is later (equal update times happen when a provider reports whole seconds, as
  Shopify does, and a record changes twice within a second); or
- both observation times are also equal and the greater observation ID wins, unless
  exactly one snapshot has a source update time.

Every other snapshot remains historical evidence and returns `retained`. Receipt time and
opaque revisions never establish order, and a source update time is never compared with
an observation time because they come from different clocks. Tombstones follow the same
rules, preventing stale resurrection. `duplicate` means the immutable snapshot already
exists, even if it was retained rather than selected.

Sources without update times, such as JTL sales orders and delivery notes, therefore
advance with each later read. This relies on the adapter contract: `observedAt` is taken
on Luma's clock before a point-in-time read starts, and one connection's reads of a
resource do not overlap. Then a late or replayed older read cannot replace a later one,
and a set of untimed reads settles on the same current snapshot in any arrival order.
When an adapter starts or stops reporting update times, the transition is ordered by
observation time.

Order lines and fulfillments have immutable canonical parent bindings. Fulfillment lines
must occur in the same connection's order projection and use its units. Split operations
stay separate; quantities are not clamped to the ordered amount. The owner revalidates
these relationships inside its transaction. A fulfillment's location is an optional
reference like a line's SKU: an unmapped location keeps its name with a null location ID,
and linking locations replays the fulfillments assigned to them.

## Versioning

Snapshot identity is `(entity, observation, normalizerVersion, mappingVersion)`.
Replaying an observation under the same identity must produce the identical document;
otherwise projection fails with `Snapshot identity conflict`.

- Bump the **adapter version** whenever the same provider response would normalize to
  different observation data, including added optional fields. Capability dispatch
  identities include the adapter version, so writes started under an earlier version
  cannot be reconciled by the new one and need operator review.
- Bump a snapshot kind's **`schemaVersion`** when its document shape changes, including
  added optional fields. Older stored documents must stay valid and readable.
- Bump the **normalizer version** whenever the canonical document for an existing
  observation changes. Replay then stores a new snapshot beside the old one instead of
  conflicting with it.

## Persistence and authority

Each owner writes its own entity, snapshot and projection tables under forced RLS with
composite tenant/source keys. Every snapshot must reference a stored observation in the
same tenant and connection; invalid provenance rolls back the snapshot and its
publication. The projection pointer, immutable snapshot and append-only publication event
commit together. Restricted roles cannot update or delete observations, mappings or
snapshots. Snapshots include a mapping signature, so resolving a previously unknown SKU
creates a new snapshot without changing the original evidence.

These reads do not authorize corrections. Workspace authority is separate configuration,
with audited overrides described in [workspace settings](workspace-settings.md#source-authority).
ADR-002's full versioned field-group publication remains designed rather than implemented. Raw provider payloads are not retained, and observations
never carry customer or address data. Imported customer profiles and the customer references
that order reads report are stored separately (see [Commerce sync](commerce-sync.md#customers)).

Order schema version 4 adds optional source-reported line unit prices and fractional tax
rates. JTL's net price and percentage tax rate and Shopify's original shop-currency unit
price and unambiguous tax line are retained without converting currencies or estimating
missing facts. Version 5 records whether each unit price includes tax as the source states
it: Shopify's order setting, and false for JTL's net prices. Prices are never converted
between net and gross, because a rate can be missing or split across jurisdictions; an
unstated or earlier-version flag is unknown. These facts do not establish an invoice total. Internal record publication uses the same owner transaction as
Sales, unlike replay recovery across independent external observations.

Inventory position schema version 2 preserves distinct provider stock states and activation.
Older Shopify observations reported committed stock in the reserved field; replay labels it
as committed and leaves the separate reserved state unknown. Earlier snapshots remain
readable and immutable. Shopify availability remains a reported fact, regardless of whether
its other state quantities are present.

Position version 3 retains corroborated stock-write references. A verified adjustment and
the current quantity are separate facts; matching quantity alone does not establish authorship.
