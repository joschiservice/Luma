# Fulfillment workspace

Fulfillment lists fulfillment orders and shipments from a selected source view, shows what blocks each one, and hosts governed source actions. It reads the
fulfillment projections described in [canonical commerce projections](commerce-projections.md)
and never writes commerce data.

Code: `@luma/read-models` (rules and reads), `@luma/orders` (`orders_fulfillment_list`).

## Model

A row is one source's current fulfillment projection. Fulfillment reconciliation keys include
the connection, so mirrored work retains separate evidence. Lists select one view per linked order and work kind instead of adding provider copies together. `kind` separates **fulfillment orders** (work a location must pick and pack, such as
a Shopify FulfillmentOrder) from **shipments** (a Shopify Fulfillment or a JTL delivery note).

**Open** work is pending or processing, not removed at the source, and its order is not
cancelled. **Progress time** is the source's last progress time, falling back to its update
time and then Luma's read time.

| Signal         | Definition                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Held           | Open work with at least one source hold.                                                        |
| Overdue        | Open work past the source's `fulfillBy`.                                                        |
| Stalled        | Open, unheld work, not scheduled to start later (`fulfillAt`), with no progress for 48 hours.   |
| Delivery issue | A shipped, undelivered shipment whose carrier reports an attempted, delayed or failed delivery. |
| Late delivery  | A shipped shipment past its estimated delivery that the source has not reported delivered.      |
| Failed         | The source reports the fulfillment failed and its order is not cancelled.                       |

Views: **attention** (any signal), **held**, **delayed** (overdue, stalled, delivery issue or
late delivery), **open**, **in transit** (shipped, not delivered) and **all**. Each rule is
written once and serves the list, the per-view counts, the detail, related fulfillments and
the Insights fulfillment chart. The stall window is returned with every read so the UI can
state it.

Facts a source does not report stay distinguishable from empty values: `holds` is null when
the adapter does not read holds (JTL), and the UI says "Not reported". Snapshots written
before fulfillment snapshot version 2 carry none of the newer facts until the next read.

Shipping sources can report possession by the merchant, warehouse or carrier. Unknown
handoffs remain explicit: label creation or booking alone does not establish dispatch.
The detail keeps the source read time apart from the carrier update time, warns when a
shipping read is more than 15 minutes old, and highlights an undelivered shipment with
no carrier update for 48 hours. A quiet carrier is an investigation cue, not proof of loss.
Older snapshots have no handoff evidence until the next source read.

## Storage

`orders_fulfillment_list` holds one row per current fulfillment projection, with the same
source's order number, status and placed date. Orders rewrites an order's rows in the same
transaction as any order or fulfillment projection change for that order, under the order
lock, and the [order list rebuild](orders-workspace.md#backfill-and-rollout) repairs them.
Filters compare plain columns because forced row security ignores JSON expression indexes.

## Reads

Reads run in one read-only, repeatable-read transaction with a 4-second statement timeout,
under the API login, which reads orders tables and mappings through `luma_case_reader`.

The list returns up to 50 rows, counts per view under the current search, filters and
conditions, the sources with rows and mapped locations with their open work. Search is literal.
The cursor is bound to the tenant, filters, conditions, grouping and sort, and carries the first
page's evaluation time so time-based views do not shift while paging. Every sort runs in either
direction; without one, `recent` and `orderPlaced` run newest first and the others ascending.
Work without the sorted value comes last in both directions; the deadline sort orders undated
work by last progress. The catalog declares the list's own sorts (`waiting`, `deadline`,
`orderNumber`) as sort-only fields, so saved views can keep the default order; `recent` is
`waiting` descending and older links are rewritten to it.

### Conditions and grouping

The list accepts conditions and groups from the Fulfillment catalog in `@luma/api-contract`, with
the shared rules for values, dates, groups and cursors described for
[Orders](orders-workspace.md#conditions-and-grouping).

- Signals use the rules above at the list's evaluation time. Holds a source does not report
  (`holds` null) are unknown: they match neither a hold reason nor `empty`, only `unknown`.
- Carrier conditions compare, case-insensitively, every carrier the shipment's tracking names.
  Has tracking means at least one tracking number. The shipping stage is the source's handoff
  stage; work without handoff evidence has no stage, which differs from a reported `unknown`.
- Groups: status, signal, shipping stage, delivery, kind, source, location, carrier, method name,
  method type, and fulfill-by, estimated delivery and order placed by day, week or month. A
  fulfillment counts in the group of each of its signals and carriers. Shipping stages group from
  merchant to warehouse, carrier, delivered and unknown, then work without a stage.
- Group counts are `complete: false` while a source still imports its fulfillment history.

The detail adds lines, the same source's order, up to 50 other fulfillments of the order, up
to 50 observed snapshots, issues, workflow runs for the order or its issues, and 25 activity
entries. A run's `progressObservedAt` is the first later read showing any fulfillment of the
order completed, shipped or delivered. A `shipping-method-correction` run is labelled
`method_correction`: it verifies the method only, not progress.

## Actions and verification

The detail mounts an installed app's `fulfillment` UI slot for open fulfillment orders of a
connection owned by that app. Shopify provides it with
[Shopify fulfillment recovery](shopify-actions.md#fulfillment-recovery): release a hold, reopen or
move, through Action Admission, separate approval and idempotent execution. That flow verifies
progress with a fresh read of fewer remaining units, separately from Shopify's acceptance. The
workspace itself never marks work restored from a request; it shows new state only from later
source reads.

## Limits

Every list read counts all views over the tenant's current fulfillments, so its cost grows
with that number. Reads stayed around 200 ms or less at 100,000 rows on a development laptop.
Grouped reads seek each group's first rows in the evaluated set, so they cost more than a page.
Tenants well beyond 100,000 current fulfillments need maintained view counts or archiving of
finished work. Re-measure with
`LUMA_FULFILLMENT_BENCHMARK=<row count> pnpm test:performance fulfillment`.

Without a source filter, lists and charts select one source view per linked order and work kind: Starshipit for shipments, otherwise Shopify, then another source. Split shipments within that view remain separate. This is display selection, not identity merging or authority for an action. Choose a source to inspect its own records; detail retains the other views. Unlinked orders remain distinct until evidence establishes their identity.
