# Fulfillment workspace

Fulfillment lists every fulfillment order and shipment that a connected source currently
reports, shows what blocks each one, and hosts governed source actions. It reads the
fulfillment projections described in [canonical commerce projections](commerce-projections.md)
and never writes commerce data.

## Model

A row is one source's current fulfillment projection. Fulfillment reconciliation keys include
the connection, so mirrored work in a store and an ERP stays separate and is never added
together. `kind` separates **fulfillment orders** (work a location must pick and pack, such as a
Shopify FulfillmentOrder) from **shipments** (a Shopify Fulfillment or a JTL delivery note).

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

Views: **attention** (any signal), **held**, **delayed** (overdue, stalled, delivery issue or late
delivery), **open**, **in transit** (shipped, not delivered) and **all**. Each rule is written once,
in `packages/read-models/src/infrastructure/fulfillment/rules.ts`, and serves the list, the per-view
counts, the detail and related fulfillments. The stall window is `stalledAfterHours` and is
returned with every read so the UI can state it.

Facts a source does not report stay distinguishable from empty values: `holds` is null when the
adapter does not read holds (JTL), and the UI says "Not reported". Historical snapshots written
before fulfillment snapshot version 2 carry none of the new facts until the next read.

## Storage

Orders owns `orders_fulfillment_list` (migration `0044_fulfillment_list.sql`): one row per
current fulfillment projection with kind, status, hold reasons, location, method, dates,
delivery state, tracking numbers, units, and the same source's order number, status and placed
date. `refreshFulfillmentList` in `packages/orders/src/infrastructure/fulfillment-list.ts`
rewrites an order's rows in the same transaction as any order or fulfillment projection change
for that order, under the order lock, and the order list rebuilder repairs them. Filters compare
plain columns because forced row security ignores JSON expression indexes.

## Read model

`createFulfillmentWorkspace` in `packages/read-models/src/infrastructure/fulfillment/workspace.ts`
implements `FulfillmentWorkspace`. Reads run in one read-only, repeatable-read transaction
under the API login, which reads orders tables and mappings through `luma_case_reader`.

The list returns up to 50 rows, counts per view under the current search and filters, the
sources with rows and mapped locations with their open work. Search matches order numbers,
tracking numbers and location names, and source order or fulfillment IDs, literally. Sorts are
`waiting` (oldest progress first), `recent` and `deadline` (fulfill-by or estimated delivery,
then waiting). The cursor is bound to the tenant, filters and sort, and carries the evaluation
time of the first page so time-based views do not shift while paging.

The detail adds the lines with their ordered quantity and SKU, the same source's order, up to 50
other fulfillments of the order, up to 50 observed snapshots, issues (the fulfillment by Luma or
source ID and the order), workflow runs for the order or its issues, and 25 Luma activity
entries. A run's `progressObservedAt` is the first later read showing any fulfillment of the
order completed, shipped or delivered. A run of `shipping-method-correction` is labelled
`method_correction`: it verifies the method only.

## Actions and verification

The detail mounts an installed app's `fulfillment` UI slot for open fulfillment orders of a
connection owned by that app. Shopify provides it with
[Shopify fulfillment recovery](shopify-fulfillment-recovery.md): release a hold, reopen or move,
through Action Admission, separate approval and idempotent execution. That flow verifies
progress with a fresh read of fewer remaining units, separately from Shopify's acceptance. The
workspace itself never marks work restored from a request; it shows new state only from later
source reads.

## Web

`apps/web/src/features/fulfillment` holds the list (`page.tsx`), detail (`detail.tsx`), URL
state (`data.ts`) and wording, states, next steps and timeline changes (`presentation.ts`).
Fulfillment is in the sidebar (`G`, then `F`), the command menu and Records open fulfillment
records there, order fulfillments, fulfillment issues and the optional **Fulfillment health**
Home module link to it. The user guide is `apps/web/content/docs/fulfillment.mdx`.

## Measurements

`apps/api/e2e/fulfillment.e2e.mjs` includes a benchmark. Set `LUMA_FULFILLMENT_BENCHMARK` to a
row count; rows spread across open, held, shipped and completed states. It writes the fastest of
three API requests per read to `/tmp/luma102-fulfillment-<count>.json`. Measured on PostgreSQL
17 in Docker on a development laptop:

| Read (ms)        | 20,000 rows | 100,000 rows |
| ---------------- | ----------: | -----------: |
| Attention view   |          41 |          162 |
| Held view        |          38 |          153 |
| All by deadline  |          53 |          200 |
| Selective search |          28 |          105 |
| Second page      |          41 |          165 |
| Deep page        |          42 |          155 |
| Detail           |          18 |           17 |

Every list read counts all views over the tenant's rows, so its cost grows with the number of
current fulfillments. Tenants well beyond 100,000 current fulfillments need maintained view
counts or archiving of finished work.

## Validation

```sh
pnpm --filter @luma/app-shopify test
pnpm --filter @luma/app-jtl test
pnpm --filter @luma/simulator-shopify test
pnpm --filter @luma/web exec vitest run src/features/fulfillment
pnpm --filter @luma/ui exec vitest run ../../apps/web/src/features/fulfillment/fulfillment.stories.tsx
pnpm test:e2e fulfillment.e2e.mjs
pnpm test:browser fulfillment.browser.mjs
```
