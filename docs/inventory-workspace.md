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
- Source filters select positions without hiding their other sources. Lists use keyset pages
  of up to 50 positions; cursors belong to the tenant, filters, conditions, grouping and sort that produced them.
- Lists order by SKU, then location, unless sorted by location, a quantity or the last read.
  A quantity sort uses the lowest value any source reports, so a position sorts by its most
  cautious figure; sources that report none are ignored. The last read is the most recent
  read of any source. Positions without a value come last in both directions, still by SKU
  and location. Positions are aggregates of their sources, so every sort orders all matching
  positions before paging.
- SKUs are labeled with a source SKU code from the product catalog when one is known,
  otherwise with the canonical key. `skuKey` keeps the canonical key that purchase orders
  and replenishment use.

## Conditions and grouping

The list accepts conditions and groups from the Inventory catalog in `@luma/api-contract`, with
the shared rules for values, dates, groups and cursors described for
[Orders](orders-workspace.md#conditions-and-grouping).

- Available, on-hand, reserved and incoming quantities, below safety stock, availability basis,
  tracking, item and location activity and the last read belong to each source. Without a source
  scope a condition matches when any source matches; `every` needs every source to report a
  matching value; a connection ID reads only that source; `lowest` compares the lowest quantity
  any source reports, as the quantity sorts do, and refuses non-quantities.
- A source without a quantity never satisfies a comparison and never counts as zero. `empty`
  matches a source that reports none, or with `lowest` a position no source reports for.
- Below safety stock compares one source's available stock with that source's safety stock; it
  is unknown, and matches neither value, when either is missing.
- Location, source, differing quantity and awaiting sync describe the position. Differences follow
  the comparison rules above; awaiting sync is the wait detail shows.
- Groups are location, SKU (one SKU across every location) and source; a position counts in the
  group of each of its sources. Groups key by canonical ID, count every match and return their
  first positions in the list's order.

Every read aggregates the typed facts of all current sources once, evaluates conditions in that
pass and orders all matches; labels, mappings and display facts are read only for the returned
positions. Groups rank every match within its group.

## Detail

The detail read includes up to 100 observed snapshots and 50 entries per related record
type. Order lines use canonical SKU relationships and retain source and unit. Purchase
orders match the canonical SKU ID or reconciliation key. Incoming stock uses outstanding open supplier orders and their effective confirmation, receipt and difference decisions. Each arrival retains its receiving location, source evidence and date confidence. Confirmed quantities supersede requested quantities; past arrival dates remain overdue. Cancelled and fully received orders contribute no incoming stock. In-transit location transfers remain a separate source. At native-owned locations the incoming ledger balance replaces supplier and transfer calculations. Independently verified supplier submissions and confirmations project into the incoming bucket through Inventory’s journal. The projection preserves each order line, receiving location, quantity, arrival date and evidence. A reviewed receipt consumes its tracked incoming units before booking available or damaged stock. Quantity changes and cancellation release the corresponding incoming units. Missing or incomplete projection evidence remains unavailable rather than an empty balance. Incoming stock never augments available stock.

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
and shipment quantities never augment position available quantities. The incoming-arrivals view shows independently outstanding shipment units separately from supplier orders; it does not add transfer totals to a provider-reported incoming balance.

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
summaries. Conditions can name the source, requested, shipped, received and unreceived
quantities, the requested time (when the source created the record) and the source's last
update; a quantity the record does not report never matches. Summaries carry no update time, so `updated` filters and
sorts but is not a column. Transfer lists do not group: the
record kind is the built-in view and routes are historical names, not identities. Detail reads retain at most 5,000 exact lines, 20 scalar history summaries with historical location facts and 50 related records
per kind. Truncation is explicit. Cursors belong to the tenant, source, filters and conditions that produced them.

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

## Native reservations and location ownership

Allocations bind native order authority, the exact order-line version and SKU/location/unit,
current available balance/version and the reviewed location scope. Available and reserved
move atomically with the reservation record and retry receipt. One active reservation per
order line/location/unit can be extended only with its current identity and version. Shortages
remain demand; they never create negative physical stock or an inferred provider promise.

Shipment reads retain complete empty results and exact order, line, location and fulfillment
mapping identities. Reads older than five minutes, unknown location/stage, changed mappings,
pending shipments and unsettled external effects stop changes. Independently verified shipped
units move reserved stock to the customer counterparty once. An unallocated shipment requires
review; it cannot consume a different line or location. Shipment effective time stays unknown
when the read does not establish it. Cancellation and quantity reductions release only remaining
units in the Sales transaction. A newly observed shipment must be consumed before release.
Expiry sweeps retain blocked holds and their reasons rather than freeing uncertain stock.

Each location progresses explicitly through observe, shadow, propose and own. Every step binds
reviewed openings, fresh zero-drift reconciliation, mappings, balances, active reservations and
workspace authority to another member's current approval. Workspace authority changes invalidate
prepared operations without changing location ownership. Initial own transitions require zero
provider commitments and reservations; ambiguous provider promises cannot be silently migrated.
Handback requires independently aligned available stock, no remaining native holds and no unsettled
effects. These operations send no provider writes or activation requests. Legacy ERP corrections
are refused at natively owned locations.

Failed native point reads retain uncertainty separately from immutable provider observations and
native balances. They pause older stock evidence until a fresh successful read. Source replacement
is refused for a location with ownership history: shipment identities need an explicit migration
review before another connection can assume the binding.

## Publishing native channel allocations

Only the reviewed own phase permits native publication to its selected Shopify connection
and exact SKU/location mappings. The channel allocation is an explicit nonnegative whole
number no larger than native available stock; quantities are never silently rounded.
Publication changes stored available quantity only. Inventory item and location activation,
provider commitments and non-promisable states require separate authority.

The immutable preview captures native account versions, opening reviews, ownership and
workspace authority revisions, mappings, the provider CAS value and inventory eligibility.
It uses the existing persistent policy, approval, Action Admission and idempotency path.
Inventory holds the pool and ownership stable during dispatch. Native stock changes require
a new preview. This is a reviewed snapshot allocation; it does not enable automatic
publication after later stock changes.

A marker recorded immediately before a possible mutation makes that exact source pool
channel evidence while its ownership version remains own. Provider on-hand derived from
published available quantity cannot establish warehouse drift or authorize physical ledger
changes. ERP-to-store mismatch detection excludes native-owned locations; existing cases
remain subject to independent verification and are not closed by this exclusion.

Verification independently checks stored quantity, unchanged eligibility and exact write
attribution. Acceptance alone does not verify quantity. Lost receipts retain uncertainty;
checks read without replaying the mutation. Observe-only creates no provider mutation or
channel-role marker.

Handback requires no native holds or unsettled effects, zero provider commitments and
reservations, and a fresh channel baseline aligned to native available, physical total,
incoming and non-promisable states. The peer review binds that channel reading separately
from physical drift evidence. Returned inspection and in-transit units must be cleared.
Handback records the authority transition; it does not activate a location, move states or
close cases.

## Manual purchase receipts

Receipt booking binds the latest cumulative manual receipt and damaged quantity to an exact receiving stock pool. Good units can enter available stock only after a reviewed booking. Shopify stock authority uses the existing governed compare-and-set correction: a changed baseline stops the write, uncertain dispatch is reconciled by reading, and receipt claims prevent another stock revision from booking the same units again. Write attribution recognises the resulting sync read without creating another receipt.

Native-owned locations use Inventory’s reviewed receipt postings. Good and damaged units enter separate balanced buckets through the owner ledger. Current receipt evidence, ownership and account versions are checked again before posting. Independent verification reads the recorded entry and current balances; later stock changes can make this exact quantity check inconclusive. The review and the entry that booked it are the receipt's cited evidence: readers with inventory access see their state, quantity and postings, others see them as restricted. Purchasing-system receipts remain owned by that purchasing system.
