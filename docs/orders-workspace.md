# Orders workspace

The Orders workspace lists current canonical orders and explains one order at a time. It
reads the per-source order projections described in
[canonical commerce projections](commerce-projections.md) and composes linked issues,
workflow runs and Luma activity. It never writes commerce data.

## Read model

`createOrderWorkspace` in `packages/read-models/src/infrastructure/orders/workspace.ts`
implements `OrderWorkspace` (`application/orders.ts`). Every read refreshes membership,
checks the tenant and runs in one repeatable-read transaction with a 4-second statement
timeout and JIT compilation turned off. It uses the API login, which reads order, mapping,
installation and exception tables through `luma_case_reader` and workflow and activity
tables through `luma_desk`. See [ADR-008](architecture/008-workspace-read-models.md).

Each canonical order can have one current snapshot per source connection. The list
shows the snapshot with the newest source update time, then the newest observation,
the same selection the order metrics use. A connection filter restricts both the
selection and the matches to that source.

| Concept           | Rule                                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outstanding       | `orders.open` v1: an open, current order with a line whose ordered quantity minus cancelled and same-source fulfilled quantity is above zero. A line without a reported cancelled quantity is unknown unless fully fulfilled. |
| Overdue           | `orders.overdue` v1: outstanding and past the source `dueAt`.                                                                                                                                                                 |
| Needs you         | `orders.attention` v1: linked to an unresolved issue with approval, manual intervention or uncertainty attention, through the inbox's `orderAttentionQuery`.                                                                  |
| Differs by source | Two or more current, non-removed sources disagree on a known status, payment status, total or per-SKU ordered quantity. Unknown values, display numbers and dates are not compared.                                           |
| Fulfillment state | Fulfilled, partial, unfulfilled or not required (every unit cancelled), from shipped, delivered or completed fulfillments of the same source. Mirrored work in another system is never added.                                 |

Each rule has one SQL definition. Order state (line progress, fulfillment state,
outstanding and overdue) comes from `orderStateQueries` in
`packages/orders/src/infrastructure/order-state.ts`, which the order metrics also use.
Needs-you comes from `orderAttentionQuery` in `packages/exceptions`, embedded in the same
transaction, so it has no size limit. "Differs by source" is
`orders/source-comparison.ts` in the read model and serves both list and detail.
`orders.integration.test.ts` still checks that the outstanding, overdue and needs-you
views count exactly the orders the metrics count.

### Search and paging

Search matches, case-insensitively and literally: any source's order number, source
order IDs, SKU text on order lines, source SKU IDs mapped to a line's SKU, and the Luma
order ID. Filters cover status, payment status, source, placed time and source update
time. Sorting uses last update (source update time, falling back to observation time),
placed date, order number (shorter numbers first, then text) or due date. Missing sort
values come last in both directions.

Pages use a keyset cursor over the sort key and order ID, so new orders do not shift
the page a reader is on. The cursor is bound to the tenant and the exact filters and
sort; any other combination is rejected with 400. Each page also returns the total
match count.

### Detail

The detail read returns every source's facts, differences, fulfillments with source
IDs, up to 100 snapshots of the order and its fulfillments, linked issues and workflow
runs, and the latest 25 activity events from the past year.

- **Issues**: fulfillment issues through the fulfillment mapping, order issues through
  the order mapping or ID, SKU issues for any ordered SKU, and workflow-failure issues
  for runs on this order.
- **Workflow runs**: Resolution runs whose target is this order (by Luma ID or any
  source order ID) or one of its issues, and trigger runs whose subject is the order.
- **Activity**: the workspace activity store filtered to those issues, runs and order
  references, with the same visibility rules as the Activity page.

Links start from the order's identities: its Luma ID, source order IDs from the mappings,
fulfillment and SKU IDs. Issues and runs are then found through indexed, generated
subject and target columns (migration `0039_order_link_indexes.sql`), and activity through
the linked issue and proposal IDs, so the cost follows the number of links rather than
table size. Row security keeps PostgreSQL from using indexes on JSON expressions, so these
lookups must stay on the plain columns. Provider actions target orders by source ID
because the provider needs it; the mappings resolve those IDs to the Luma order.

History entries are observations Luma read, not source events. Genuine Shopify events
come from the Shopify app's live read.

## Source facts and live context

Adapters populate optional canonical facts: `placedAt`, `total` and line `skuCode` and
`title`. Existing snapshots keep working without them and gain them with the next source
update. Customer, payment transaction, return and refund details are not stored.

For those, the web app mounts the owning app's `record` UI slot for each source
connection (see [workspace apps](apps.md)). The Shopify app reads the order live
through its authorized `records` operation, so installed capabilities, granted scopes
and protected customer data approval apply unchanged.

## Performance

`orders.integration.test.ts` pages through a 2,000-order import end to end on every
run. With `LUMA_ORDER_BENCHMARK=50000` it imports 50,000 orders (66,667 source
snapshots, a third of orders in two sources), analyzes the tables, records timings and
query plans in `/tmp/luma98-order-queries.json`, and walks the first ten pages. Measured
on PostgreSQL 17 in Docker on a development laptop, as the range of four runs:

| Read                                   | Time       |
| -------------------------------------- | ---------- |
| First page, placed date, 100 rows      | 173–191 ms |
| Following pages through the cursor     | 159–167 ms |
| Default sort                           | 150–159 ms |
| Order number search                    | 141–164 ms |
| SKU text search, every order matching  | 251–277 ms |
| Outstanding view                       | 277–303 ms |
| Differs view                           | 229–259 ms |
| Order detail with history and activity | 49–67 ms   |

Each list read selects the current source of every order in the tenant before filtering,
so time grows with order count; that selection carries scalar columns only, and line data
is read just for the rows that need it. Row enrichment (sources, differences, progress)
runs only for the page, except where a view filters on it. Views that need fulfillment
progress classify only open, current orders, and "differs" compares only orders with two or
more sources. JIT compilation is off for these reads because it cost over a second on the
larger plans.

Search scans the tenant's current order snapshots with `ILIKE`. Trigram indexes would not
help: row security keeps PostgreSQL from using them for `ILIKE`. Before tenants reach
several hundred thousand orders, add a maintained per-order search and sort table owned by
`@luma/orders`.

## Validation

```sh
pnpm --filter @luma/web test
TEST_DATABASE_URL=… pnpm --filter @luma/application-runtime exec vitest run src/orders.integration.test.ts src/activity.integration.test.ts
pnpm test:browser orders.browser.mjs
pnpm --filter @luma/ui exec vitest run ../../apps/web/src/features/orders/orders.stories.tsx
```
