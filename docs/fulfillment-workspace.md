# Fulfillment workspace

Fulfillment lists every fulfillment order and shipment that a connected source currently
reports, shows what blocks each one, and hosts governed source actions. It reads the
fulfillment projections described in [canonical commerce projections](commerce-projections.md)
and never writes commerce data.

Code: `@luma/read-models` (rules and reads), `@luma/orders` (`orders_fulfillment_list`).

## Model

A row is one source's current fulfillment projection. Fulfillment reconciliation keys include
the connection, so mirrored work in a store and an ERP stays separate and is never added
together. `kind` separates **fulfillment orders** (work a location must pick and pack, such as
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

## Storage

`orders_fulfillment_list` holds one row per current fulfillment projection, with the same
source's order number, status and placed date. Orders rewrites an order's rows in the same
transaction as any order or fulfillment projection change for that order, under the order
lock, and the [order list rebuild](orders-workspace.md#backfill-and-rollout) repairs them.
Filters compare plain columns because forced row security ignores JSON expression indexes.

## Reads

Reads run in one read-only, repeatable-read transaction with a 4-second statement timeout,
under the API login, which reads orders tables and mappings through `luma_case_reader`.

The list returns up to 50 rows, counts per view under the current search and filters, the
sources with rows and mapped locations with their open work. Search is literal. The cursor is
bound to the tenant, filters and sort, and carries the first page's evaluation time so
time-based views do not shift while paging.

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
Tenants well beyond 100,000 current fulfillments need maintained view counts or archiving of
finished work. Re-measure with `LUMA_FULFILLMENT_BENCHMARK=<row count>` on
`fulfillment.e2e.mjs`.
