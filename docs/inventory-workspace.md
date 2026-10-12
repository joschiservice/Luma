# Inventory workspace

Inventory groups current canonical stock projections by SKU, location and unit. Each
connection keeps its own quantities: no source is implicitly authoritative and quantities
are never summed across sources.

Code: `@luma/read-models` (reads), `inventory` API contract. Reads use tenant transactions
and existing read grants.

## Rules

- Known decimal quantities are compared at their canonical six-decimal precision. Missing
  values never become zero.
- Reservation comparisons require the same source semantics. Shopify reserved stock is not
  compared with an ERP reservation quantity; Shopify committed stock is shown separately.
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
allocation. Provider incoming quantities remain distinct from these commitments and are shown only when
reported. They are never added to available stock.

Linking or unlinking matching SKUs from other sources requires `sync.manage`.

## Corrections

People with `shopify:inventory_corrections.apply` can review an ERP-backed Shopify
available-stock correction from stock detail. A different administrator approves the exact
source, location and quantity. Writes require fresh evidence, unambiguous mappings and
inventory write access. Acceptance and independently verified stock remain separate
states; see [Shopify inventory corrections](shopify-actions.md#inventory-corrections).

## Provider stock states

Position schema version 2 retains committed, incoming, damaged, quality control and safety
stock alongside reserved and available. Shopify reports each directly; Luma never derives
Shopify availability. Location activity, item activation and tracking are independent facts;
stored quantities do not prove a location can sell them. Reads and history show missing values
as unknown. Earlier Shopify snapshots retain their immutable document: the former reserved
field was committed stock and is labeled accordingly, with separate reserved stock unknown.
Replaying earlier observations writes a new version beside the retained evidence.

Position version 3 adds independently corroborated stock-write attribution. It links the
accepted action to a provider adjustment and records whether that reading matches the
action's quantity. A changed or unknown quantity remains distinct; attribution never
suppresses residual differences. History retains the attribution of each individual read.

See [quantity ledger and ownership](architecture/013-stock-ledger.md) for the separate native
quantity model. These provider facts neither post ledger entries nor select ownership.

## Transfers and receiving

Transfers and shipments are separate source records with separate read grants. A transfer
retains requested, allocated-to-draft-shipment, ready and shipped line quantities. A shipment
retains accepted, rejected and unreceived line quantities and the provider's receipt total.
Shopify's receipt total includes cancellations; it is not an accepted-stock balance. Transfer
and shipment quantities never augment position available or incoming quantities.

Location names, addresses and snapshot times describe the historical request. A missing live
location identity stays unknown; matching names never establish a pool. Relationships use
exact provider IDs within one connection. SKU or location remapping replays dependent facts.
Creation and first-receipt times are lifecycle evidence, not update times. Shopify exposes no
transfer modification watermark, so these streams perform complete paginated scans.

Receiving checks require an active source, current requested and granted capability, a known
non-draft lifecycle, complete line collections and an observation at most five minutes old.
Inconsistent totals request another read. Rejected units and terminal unreceived units require
investigation. An estimated arrival in the past with unreceived units establishes only an
unconfirmed receipt, never proven physical loss. These bounded advisory signals do not
submit claims, change stock or close cases. Missing collections suppress conclusions instead
of becoming empty. Removed records retain their last known name and history; current
quantities remain unknown. Stale or inaccessible evidence remains inspectable with its limitations.

A purchase order relates only through an external reference whose system is
`shopify_inventory_transfer` or `shopify_inventory_shipment`, with the exact provider GID and
connection ID. Viewing that link requires procurement access. The linked order owns its
receipt context; matching names, SKUs and quantities are insufficient.

Receiving evidence exports retain source identities, current snapshots, observed history and
explicit links. Supplier confirmations, shipping notices, delivery documents, photos and claim
deadlines need their own evidence and policy. A Shopify arrival estimate cannot establish a
3PL claim window. Provider-specific claim preparation remains gated by selection and policy;
downloads do not send a claim.

Operational lists read scalar stage facts from a tenant-scoped index and return at most 50
summaries. Detail reads retain at most 5,000 exact lines, 20 scalar history summaries with historical location facts and 50 related records
per kind. Truncation is explicit. Cursors belong to the tenant, source and filters that produced them.

## Bundle evidence

A catalog variant's source recipe preserves exact component identities and quantities.
Current recipes are independent of sold order groups and their fulfillment or return lines.
Provider observations neither post native stock nor create a separate bundle balance;
physical allocation follows component SKUs under the quantity ledger semantics. Unknown
visibility differs from a confirmed empty recipe. Plain SKU text cannot establish either
component or parent identity. SKU remapping replays dependent recipes through the owner's
current dependency index. Lists return scalar parent flags; recipes are read only for the
selected SKU, with at most 5,000 source edges. Detail displays the first 100 edges.

Known Shopify bundle parents cannot receive independent available-stock corrections.
The provider checks the current parent flag and first recipe edge again before dispatch.

## Shadow quantity ledger

Inventory owns immutable balanced stock postings. Each account retains one canonical SKU,
location, unit and state; external drift additionally retains the exact connection. Quantities
use six decimal places and versions are integers represented as strings. Commands lock accounts
in one identity order, check every expected balance and version, and retain the original receipt.
Changing content under an accepted command key fails rather than retrying different work.

A stock pool starts with a reviewed opening from a complete provider read observed within five
minutes. Another current member with stock approval permission must review it. Posting checks
source quantities, mappings, SKU composition and reviewer permission again. Provider commitments
never create native order reservations. Zero openings retain their review and receipt without
inventing zero postings. Later corrections and production movements require their own review.
A reversal opposes every original posting and still checks current stock limits.

Shadow reconciliation compares provider on-hand with the native on-hand buckets. Incoming and
in-transit quantities remain separate. Evidence must follow the latest native physical posting;
stale or incomplete evidence produces no difference. Reconciliation changes only a connection's
virtual drift account and its balancing counterparty. It sends no provider write and grants no
stock ownership. Shopify openings require a live composition read or a fresh complete catalog
classification so that bundle parents cannot acquire physical stock.

Historical reads require effective time, recorded knowledge time and an account version limit.
Unknown effective times are returned separately. A checkpoint is used only when its whole prefix
fits those cutoffs; backdated postings recorded later do not change earlier knowledge. Server
recording times use millisecond precision consistently with API timestamps.

Transit, returned-inspection and drift aging returns bounded advisory candidates linked to the
entry that started the current nonzero episode. The age describes a continuously nonzero aggregate
balance, not the age of individual units. Unknown effective time uses recording time explicitly.
A candidate alone does not establish physical loss, delay or resolution.
