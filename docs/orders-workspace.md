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
`packages/orders/src/infrastructure/source-comparison.ts` and serves both list and detail.
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
sort; any other combination is rejected with 400. Pages return `totalCount: null` by default. Pass `count=exact` to request the total
match count; this counts every match and costs more for broad filters. Changing only
this option does not invalidate a cursor.

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
update. Returns and refunds are imported as order children and listed in **Returns and
refunds** (see [Returns workspace](returns-workspace.md)). Customer and payment
transaction details are not stored.

For those, the web app mounts the owning app's `record` UI slot for each source
connection (see [workspace apps](apps.md)). The Shopify app reads the order live
through its authorized `records` operation, so installed capabilities, granted scopes
and protected customer data approval apply unchanged.

## Maintained list projection

`@luma/orders` owns `orders_list`: one row per order and source, with a unique selected
row per order. It stores current scalar filter fields, fulfillment state, source differences
and sort keys. Tenant-leading B-tree indexes serve each sort in both directions, with
missing values last. Keyset queries seek within the known and missing value groups
separately, so deep pages do not scan the preceding pages.

`refreshOrderList` updates these rows in the same transaction as the current snapshot
pointer and publication event. Order writes and all sibling fulfillment writes share the
parent order's advisory transaction lock. Retained history and duplicate replay leave the
list unchanged. Applied order writes also replace search links and SKU relationships;
fulfillment writes update state without rewriting search terms. Source comparison and
progress SQL come from Orders and are shared with detail and metrics.

Stored progress includes all current fulfillments. `state_valid_from` records when all
contributing observations have occurred. Reads before that instant recompute only those
future-dated sources with the existing as-of rules. Overdue remains a read-time comparison
with `due_at`; no timer needs to rewrite orders when a deadline passes.

### Literal search under row security

`orders_search_values` stores each distinct value once per tenant, including shared SKU
text. SHA-256 identifies dictionary values, and links verify the original value too.
`orders_search_grams` stores distinct one-, two- and three-character substrings of the
lowercased value. Equality lookups on `(tenant_id, gram, value_id)` find candidates, then
`ILIKE` verifies the escaped literal query against those values. This avoids relying on
non-leakproof `ILIKE` as an index predicate under forced RLS. It preserves punctuation,
Unicode, short searches and literal percent, underscore and backslash characters.

`orders_search_links` connects dictionary values to current order sources. Values are
separate, so a match cannot span fields. Unreferenced dictionary values are retained and
cannot produce an order hit; dictionary storage therefore includes previously indexed
text. `orders_list_skus` indexes current canonical SKU relationships. Connections owns
`connector_mapping_grams`, populated atomically by its mapping insert trigger. Joining
matching aliases to current SKU relationships makes mapping-only changes visible without
a fan-out refresh or a cross-owner transaction. Connection filters apply to both the
matching alias and the order source. Luma order IDs use exact UUID equality.

The reader samples at most 1,001 postings per query fragment to choose a selective
starting fragment, then probes up to 1,001 matching references. A selective search passes its complete
order-ID set to the list query. A broad search walks the requested sort index and tests
membership, avoiding expansion of a common SKU into every matching order. Both statements
share the repeatable-read snapshot. Broad searches over many distinct values and exact
counts still cost more than selective searches; arbitrary substring matching is not
constant-time.

Attention remains owned by Exceptions. Ordinary pages evaluate attention only for their
order IDs through `orderAttentionForOrders`. The needs-you view evaluates unresolved
fulfillment issues before selecting its page.

### Backfill and rollout

Migration `0041_order_list_projection.sql` creates the schema and mapping postings. It
marks tenants with existing projections in `orders_list_backfill`. Their lists continue
using `legacy-list-query.ts` until the final rebuild batch commits. New writes maintain
the projection during the backfill; new tenants use it immediately.

Deploy the migration and the updated ingestion writer before running the rebuild. Drain
old writer processes before the final cutover. Build the packages, then run for each
pending tenant using a restricted login inheriting `luma_orders`:

```sh
pnpm exec turbo run build --filter=@luma/orders...
ORDERS_DATABASE_URL=… node tooling/orders/rebuild-list.mjs <tenant-uuid>
```

The command resumes the saved checkpoint in batches of 500 orders. Each batch uses the
same parent-order locks as ingestion. The final batch removes the pending marker atomically;
readers then use the complete projection. The same command repairs an already published
projection from the beginning. Run `ANALYZE` on the new tables after large backfills.
To temporarily return a tenant to legacy reads, insert its ID into `orders_list_backfill`
with a null `after_id`, then rebuild. Keep the writer maintaining both representations.

### Measurements

`orders.integration.test.ts` walks a 2,000-order import end to end. Set
`LUMA_ORDER_BENCHMARK=500000` or `1000000` for larger imports with a third of orders in two
sources. The benchmark measures ordinary, selective, broad, connection-filtered and deep
cursor reads, exact counts, backfill and an order update. Restricted API-role query plans
and relation sizes are written to `/tmp/luma116-order-queries-<count>.json`. Write plans
also verify that a single-order refresh uses dictionary hash lookups rather than scanning
all stored search values.

Measured on PostgreSQL 17 in Docker on a development laptop, with 100 rows per page:

| Read                    | 50,000 orders | 1,000,000 orders |
| ----------------------- | ------------: | ---------------: |
| First page, placed date |         31 ms |            86 ms |
| Default sort            |         11 ms |            39 ms |
| Selective number search |          8 ms |            81 ms |
| Common SKU search       |         13 ms |            44 ms |
| One-character search    |         16 ms |            33 ms |
| Outstanding view        |         11 ms |            20 ms |
| Deep cursor             |         12 ms |            33 ms |
| Exact count with page   |         17 ms |            66 ms |

These are individual synthetic runs, not latency percentiles or production targets. The
million-order final-reader plans are in `/tmp/luma116-final-million.json`. Its dataset has
1,333,333 imported source snapshots and a small fixture of source mappings. It exercises
shared SKU fan-out but does not represent a million distinct source aliases. Alias-only
updates, broad alias queries, source scoping and tenant isolation have separate tests.

The Orders-owned list, dictionary, postings and relationship tables, including indexes,
used about 5.9 GiB at one million orders. Mapping postings add storage proportional to
source aliases. Exact counts, rare combinations of broad search and filters, and retained
unreferenced dictionary values can still increase work.

After removing a dictionary scan from the write plan, a single-order update measured
18 ms at 50,000 orders; its list refresh and search-link insert each used indexed lookups
and took under 1 ms in `EXPLAIN ANALYZE`. The final write-plan change was checked at 50,000
orders, after the million-order reader run. The disposable database disables durable
flushes, so these write timings are not production durability measurements.

## Validation

```sh
pnpm --filter @luma/web test
TEST_DATABASE_URL=… pnpm --filter @luma/application-runtime exec vitest run src/orders.integration.test.ts src/activity.integration.test.ts
pnpm test:browser orders.browser.mjs
pnpm --filter @luma/ui exec vitest run ../../apps/web/src/features/orders/orders.stories.tsx
```
