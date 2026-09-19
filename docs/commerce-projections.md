# Canonical commerce projections

`createCommerceServices(databaseUrl)` wires the connector source store, orders and
inventory owners, and the commerce ingestion workflow. Call it with a restricted
login inheriting `luma_connectors`, `luma_orders` and `luma_inventory`. Close the
service when its worker stops. All methods require a resolved tenant context;
ingestion and mapping require an owner or admin.

## Ingest and reconcile

1. Pass an `orders.read`, `inventory.read` or `fulfillment.read` observation to
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

## Projection rules

Only complete normalized object snapshots or explicit tombstones are accepted.
Partial collection pages can supply complete individual objects; missing items in
those pages never delete stored entities. Required nulls distinguish unknown
values from omitted fields. Order lines can retain an unknown SKU or cancelled
quantity. Inventory values retain null, zero, negative and fractional quantities
without deriving or summing stock across sources.

Each source has its own current snapshot. A strictly newer source update time can
advance it. Older, equal-time or unordered observations remain historical evidence
and return `retained`; receipt time and opaque revisions never establish order.
A tombstone follows the same ordering rule, preventing stale resurrection. If an
existing snapshot lacks source time, an authoritative reconciliation decision is
needed before advancing it. `duplicate` means the immutable snapshot already
exists, even when it was previously retained rather than selected.

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
Restricted roles cannot update or delete observations, mappings or snapshots.
The projection pointer, immutable snapshot and append-only publication event commit
together. Snapshots include a mapping signature, so resolving a previously unknown
SKU creates a new canonical snapshot without changing the original evidence.

These are per-source projections, not a cross-source authority selection. Consumers
must explicitly select a source. The detection configuration continues to own
comparison authority; these reads do not authorize corrections. ADR-002's future
field-group authority publication and remapping workflow are not activated by this
storage layer. Raw provider payloads and customer/address data are not retained.

`commerce.integration.test.ts` runs against PostgreSQL with restricted credentials.
It covers pending/replay, concurrent delivery, immutable conflicts, isolation,
source disagreements, timestamps, tombstones, decimal precision, split shipments,
and parent/unit validation.
