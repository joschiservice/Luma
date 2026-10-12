# Orders workspace

The Orders workspace lists current canonical orders and explains one order at a time. It
reads the per-source order projections described in
[canonical commerce projections](commerce-projections.md) and composes linked issues,
workflow runs and Luma activity. Released native order commands write through the Sales owner.

Code: `@luma/read-models` (reads), `@luma/orders` (list projection and order-state SQL).

## Reads

Every read refreshes membership, checks the tenant and runs in one repeatable-read
transaction with a 4-second statement timeout and JIT compilation turned off. It uses the
API login, which reads order, mapping, installation and exception tables through
`luma_case_reader` and workflow and activity tables through `luma_desk`. See
[ADR-008](architecture/008-workspace-read-models.md).

Each canonical order can have one current snapshot per source connection. The list shows
the snapshot with the newest source update time, then the newest observation, the same
selection the order metrics use. A connection filter restricts both the selection and the
matches to that source.

| Concept           | Rule                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outstanding       | `orders.open` v1: an open, current order with a line whose current quantity (or ordered minus cancelled quantity) minus same-source shipped quantity is above zero. A line without current or cancelled quantities is unknown unless fully fulfilled. |
| Overdue           | `orders.overdue` v1: outstanding and past the source `dueAt`.                                                                                                                                                                                         |
| Needs you         | `orders.attention` v1: linked to an unresolved issue with approval, manual intervention or uncertainty attention.                                                                                                                                     |
| Differs by source | Fresh, complete sources still disagree after the propagation window and every source has been reread after it. Pending and inconclusive comparisons do not match this filter.                                                                         |
| Fulfillment state | Fulfilled, partial, unfulfilled or not required (every unit removed), from shipped, delivered or completed shipments of the same source. Fulfillment work is not counted as a second shipment. Mirrored work in another system is never added.        |

The list, detail and [order metrics](operational-metrics.md) share the Orders state rules.
Order state comes from Orders; needs-you comes
from the Exceptions attention query, embedded in the same transaction so it has no size
limit. Keep it that way: the outstanding, overdue and needs-you views must count exactly
the orders the metrics count.

### Search and paging

Search matches, case-insensitively and literally: any source's order number, source
order IDs, SKU text on order lines, source SKU IDs mapped to a line's SKU, and the Luma
order ID. Sorting uses last update (source update time, falling back to observation time),
placed date, order number (shorter numbers first, then text) or due date. Missing sort
values come last in both directions.

Pages use a keyset cursor over the sort key and order ID, so new orders do not shift the
page a reader is on. The cursor is bound to the tenant and the exact filters and sort; any
other combination is rejected with 400. `totalCount` is null unless the request passes
`count=exact`, which counts every match and costs more for broad filters. Changing only
that option does not invalidate a cursor.

### Detail

Detail resolves lines and quantities, lifecycle and cancellations, fulfillment and location,
and tracking independently through the workspace authority reader in the same database
snapshot. The comparison labels each group's authoritative connection or shows unknown or
conflicting authority. Missing or removed reports from the selected authority yield null
facts, never another source's values. Unread tracking remains null. The default line view
uses line authority when that source reports the order; people can still inspect other
sources. Payment, totals and display metadata have no authority rule in this initial model.

The detail read returns every source's facts and differences, fulfillments with source IDs,
up to 100 snapshots of the order and its fulfillments, linked issues and workflow runs, and
the latest 25 activity events from the past year. Activity uses the same visibility rules as
the Activity page.

Links start from the order's identities: its Luma ID, source order IDs from the mappings,
fulfillment and SKU IDs. Issues and runs are found through indexed, generated subject and
target columns, and activity through the linked issue and proposal IDs, so the cost follows
the number of links rather than table size. Row security keeps PostgreSQL from using
indexes on JSON expressions, so these lookups must stay on the plain columns. Provider
actions target orders by source ID because the provider needs it; the mappings resolve
those IDs to the Luma order.

History entries are observations Luma read, not source events. Genuine Shopify events come
from the Shopify app's live read.

### Comparison evidence and propagation

Comparisons use explicitly shared canonical line IDs, or a mapped SKU that occurs once
per source. Repeated SKU lines without line mappings are inconclusive; quantities are never
summed to guess line identity. Ordered, current, cancelled, fulfilled and remaining units,
unit, fulfillment state and mapped location allocations are compared independently. A
missing line in a complete order report has zero current units. Other missing facts stay
unknown. Display numbers, timestamps and location names never establish equivalence.

Shipment quantities are summed only within one connection and line. Completed fulfillment
work, labels and tracking alone do not establish dispatch. Only shipped, delivered or
completed shipment records contribute. Split shipments retain their location allocations;
mirrors in another source are compared, never added. Shipped units above known current
units produce overfulfillment evidence, including for a single source.

The default propagation window is 15 minutes from the last observed business-state change.
Identical polls retain that change time. A difference stays pending until every contributing
order and fulfillment has been reread after the window. Reads more than five minutes old,
future reads, failed or partial collection reads, unfinished pagination, unknown fulfillment
status and ambiguous mappings are inconclusive. Elapsed
time alone cannot confirm a difference. These are comparison defaults, not provider service
promises. Each difference retains source values and immutable snapshot, observation and
read-time references. Detail resolves current authority separately, including unknown or
conflicting authority; comparisons do not authorize correction or create cases.

List reads apply time checks to maintained scalar metadata. During a projection rebuild,
orders without refreshed comparison metadata are inconclusive. Rebuild with the existing
resumable procedure below; ingestion refreshes affected orders under the same owner locks.

## Change plans

A change plan says what a supported order change still needs: which systems show it, what
has shipped, whether the change is still safe, and the ordered steps with who does each.
Plans read the same snapshot, comparison rules, line identities and five-minute freshness
as detail; they change nothing and do not create cases or tasks. `@luma/orders` owns the
rules; the read model supplies facts, authority, grants and write modes.

Without parameters a plan covers each change the comparison detected while it is pending
or confirmed: current units (a zero means a line added or removed), cancellation and
location. Inconclusive comparisons plan nothing. Addresses are not compared, so address
plans exist only as proposals. A proposal names the kind; quantity and line removal name
the line by comparison key.

| Change            | Safe only while                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Quantity decrease | No fulfilment source has started work on the line and the new quantity is at least the shipped units.                 |
| Quantity increase | The lifecycle authority reports the order neither cancelled nor completed. Started work only adds a warehouse notice. |
| Line added        | As an increase. A removal is a decrease to zero.                                                                      |
| Address           | No work has started and nothing has shipped on any line.                                                              |
| Location          | Work for the line is still pending.                                                                                   |
| Cancellation      | No work has started on any line. Shipped units add a return or refund step for finance.                               |

Work has started on a line when any current fulfilment record of a source with fulfilment
access covers it with units and is `processing` or `failed`, or is a shipment that shipped,
delivered or completed. Fulfilment work counts alone do not start work, and every source is
checked, so mirrored work in another system still counts. Shipped units are summed within
one source and line, as comparisons do; across sources the fulfilment authority's count
wins, else the largest report, never a sum.

Safety is unsafe when a rule above fails, otherwise unknown when Luma lacks evidence, and
safe only when neither applies. Unknown comes from a contributing order or fulfilment read
older than five minutes or in the future; a failed, partial or unfinished latest collection
read; unknown fulfilment status on the line; lines that cannot be matched across sources;
unresolved or conflicting authority for the fact the change needs (lines, lifecycle or
fulfilment); no intended value; no source with fulfilment access; or a reader without
`fulfillment.read`. A system whose own value is unknown, such as JTL without current units,
is listed as unknown but does not by itself make the change unsafe.

Steps are ordered: stop, hold or confirm work that may be in progress (or ask a person to
check progress when it is unknown), then return or refund work, then update each system
that does not show the change with the authoritative system first, then notices, and an
escalation last when the plan is not safe. A step is a Luma step only when the target
connection's app declares a governed capability for the change; today that is Shopify's
`orders.quantity.edit` for quantity and line removal. Every other system update, hold,
reassignment, redirect and refund is a person step with a role. A Luma step is executable
only when the plan is safe, the capability is granted, the connection is available,
authority allows it, the source lines are mapped, the quantity is whole and writes are
enabled; otherwise it names the first reason. Authority allows a connection to amend a fact
group it holds, or to receive the value of the connection that holds it: the target must
equal what that source reports for the same line, read fresh and complete (otherwise
`unknown`). Any other value, and unknown or conflicting authority, is `authority`. The
provider action applies the same rule again at preview and dispatch. Whether the reader holds the app's `actionAccess`
permission is reported separately. Executable steps still go through the app's preview,
approval, admission and verification; the plan only prefills the app's `record` slot.

## Source facts and live context

Adapters populate optional canonical facts: `placedAt`, `total` and line `skuCode` and
`title`, along with current order units and remaining fulfillment work. Snapshots without
them keep working and gain them with the next source update. Current units and original
ordered units stay separate; source comparisons use mapped line business state. Unknown
reductions remain unknown. Outstanding units are never negative after refunds.
Returns and refunds are order children (see [Returns workspace](returns-workspace.md)).

Delivery and charges show each source's commercial facts as that source reported them
(order schema version 6, see [projection rules](commerce-projections.md)): currencies,
amounts as placed and current, shipping lines, discounts, tax lines, tags and operational
attributes, with the source read and update times. A group a source does not report is
labeled as not reported by that source, never shown as zero or empty. Amounts are not
compared across sources and have no authority rule.

Order addresses are customer data kept in the erasable customer store, not in order
evidence. Detail returns them per source only to readers who can also read customers;
otherwise `hidden` lists `addresses` and the page says access is restricted. A source
reports them as shared, not shared (the deployment is not approved to read them) or not
imported (no read recorded them). Customer names, contact details and payment transactions
are not stored. For those, the web app mounts the owning app's `record` UI slot per source
connection (see [workspace apps](apps.md)). The Shopify app reads the order live through its
authorized `records` operation, so installed capabilities, granted scopes and protected
customer data approval apply unchanged.

## Maintained list projection

`orders_list` holds one row per order and source, with a unique selected row per order. It
stores current scalar filter fields, fulfillment state, source differences and sort keys.
Tenant-leading B-tree indexes serve each sort in both directions, with missing values last.
Keyset queries seek within the known and missing value groups separately, so deep pages do
not scan the preceding pages.

The projection is refreshed in the same transaction as the current snapshot pointer and
publication event. Order writes and all sibling fulfillment writes share the parent order's
advisory transaction lock. Retained history and duplicate replay leave the list unchanged.
Applied order writes also replace search links and SKU relationships; fulfillment writes
update state without rewriting search terms.

Stored progress includes all current fulfillments. `state_valid_from` records when all
contributing observations have occurred; reads before that instant recompute only those
future-dated sources with the as-of rules. Overdue remains a read-time comparison with
`due_at`, so no timer rewrites orders when a deadline passes.

### Literal search under row security

Forced RLS makes PostgreSQL ignore trigram indexes and non-leakproof `ILIKE` predicates, so
search uses its own postings. `orders_search_values` stores each distinct value once per
tenant (SHA-256 identifies a value; links verify the original text).
`orders_search_grams` stores the distinct one-, two- and three-character substrings of the
lowercased value. Equality lookups on the grams find candidates, then `ILIKE` verifies the
escaped literal query. This preserves punctuation, Unicode, short searches and literal
percent, underscore and backslash characters.

`orders_search_links` connects values to current order sources. Values are separate, so a
match cannot span fields. Unreferenced values are retained but cannot produce a hit.
Connections owns `connector_mapping_grams`, maintained by its mapping insert trigger; the
reader joins matching aliases to current SKU relationships, so mapping-only changes become
searchable without a fan-out refresh or a cross-owner transaction. Connection filters apply
to both the matching alias and the order source. Luma order IDs use exact UUID equality.

The reader samples at most 1,001 postings per query fragment to choose a selective starting
fragment, then probes up to 1,001 matching references. A selective search passes its
complete order-ID set to the list query; a broad search walks the requested sort index and
tests membership, so a common SKU is not expanded into every matching order. Broad searches
over many distinct values and exact counts still cost more; substring matching is not
constant-time.

Attention stays owned by Exceptions. Ordinary pages evaluate it only for their order IDs;
the needs-you view evaluates unresolved fulfillment issues before selecting its page.

### Backfill and rollout

A tenant listed in `orders_list_backfill` still reads through the legacy list query, and
its orders chart on Insights returns 503, until a rebuild completes. New writes always
maintain the projection, and new tenants use it immediately.

Rebuild a pending tenant, or repair an already published projection, with a restricted login
that inherits `luma_orders`:

```sh
pnpm exec turbo run build --filter=@luma/orders...
ORDERS_DATABASE_URL=… node tooling/orders/rebuild-list.mjs <tenant-uuid>
```

The command resumes the saved checkpoint in batches of 500 orders under the same
parent-order locks as ingestion. The final batch removes the pending marker atomically. Run
`ANALYZE` on the projection tables after large rebuilds. To return a tenant to legacy reads
temporarily, insert its ID into `orders_list_backfill` with a null `after_id`, then rebuild.

## Limits

List reads stayed under 100 ms per 100-row page for default, sorted, selective, broad,
one-character, outstanding, deep-cursor and exact-count reads at one million synthetic
orders (a third in two sources), on PostgreSQL 17 on a development laptop. The projection
and search tables used about 6 GiB at that size; mapping postings add storage proportional
to source aliases. That dataset did not include a million distinct source aliases. Exact
counts, rare combinations of broad search and filters, and retained unreferenced values can
still increase work. Re-measure with `LUMA_ORDER_BENCHMARK=<order count>` on the Orders
integration test, which also checks that a single-order refresh uses dictionary hash lookups
instead of scanning stored search values.

## Luma-owned records

The `luma-erp-orders` release flag defaults to false. When enabled, people with
`sales.manage` and `sync.manage` can accept a known Shopify order into one Luma record.
Intake links the sources using canonical identities, never their numbers. It is retry-safe
and does not change workspace authority. Select Luma ERP for order lifecycle and lines
through the audited source-authority settings before editing.

Sales stores addresses separately from immutable evidence. Edits check the reviewed version
and current permissions, and commit the record, changed evidence and audit together.
An unchanged document or an address-only edit writes no snapshot. Quantity changes clear
the imported total because discounts, shipping and tax adjustments are not recalculated.
Cancellation preserves original units and publishes zero current units; reopening is refused.

Line unit price and fractional tax rates use canonical order schema version 4; version 5
adds whether the unit price includes tax, and version 6 the commercial facts above. They
are source-reported facts, not invoices. Missing prices, ambiguous tax rates and unstated
tax inclusion remain unknown.
Stored earlier schema versions remain readable. See
[ADR-012](architecture/012-native-order-records.md) for ownership and retention.
