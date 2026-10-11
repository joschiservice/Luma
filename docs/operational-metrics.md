# Operational metrics

The metric registry holds domain-owned, versioned counting rules for orders, cases, stock,
purchase orders, connections and resolution outcomes. The server computes every count and its
matching records (the cohort) from the same facts in one authorized PostgreSQL snapshot; the
browser never counts a loaded page. Live delivery only tells clients to read again; events
never carry or increment counts.

Code: definitions and SQL stay with their owners (`@luma/orders`, `@luma/exceptions`,
`@luma/procurement`, `@luma/connections`, `@luma/resolution`); `@luma/read-models` composes
them. Every metric route and the stream require `insights.read`.

## Order metrics (v1)

The counting unit is a canonical order ID. Explicit source mappings reconcile provider orders
and lines; matching display numbers never establish identity. Without a connection filter,
the accepted order snapshot with the latest source update time wins (null timestamps last),
then the latest observation, then connection ID. This deterministic choice does not imply
synchronized provider clocks. A connection filter selects that source first. Fulfillment
quantities come only from the selected connection, so mirrored shipments are not added
twice.

- **`orders.open`:** a nondeleted order has status `open` and at least one line has positive
  remaining quantity: current units (or ordered minus cancelled units) minus completed,
  shipped or delivered shipment quantities, clamped at zero. Fulfillment work is not a shipment. Partial fulfillment counts once. Pending, processing, failed,
  cancelled and deleted fulfillments do not reduce remaining work. Completed or cancelled
  orders never count, including cancellation after shipment. A newer accepted open snapshot
  can reopen an order if work remains. Empty lines, unknown statuses and missing current and cancellation
  quantities make the classification unknown unless another line establishes remaining work
  or fulfillment covers all units.
- **`orders.overdue`:** an open order has a source-provided `dueAt` strictly before `asOf`.
  Equality is not overdue. A missing deadline is unknown. Luma never derives a promise from
  receipt times, and the current adapters supply no deadline, so overdue is unknown for their
  open orders.
- **`orders.attention`:** a nondeleted order has at least one mapped fulfillment issue
  satisfying the inbox's approval, manual-intervention or uncertainty rules. Multiple issues
  count the order once. Unlinked workflow, stock and connection issues do not imply
  order-level attention.

Accepted projections are authoritative: duplicate replay is idempotent, older source
revisions stay in history without replacing current state, and newer corrections replace it.
Reading history by observation time would revive rejected source updates.

The Orders workspace views use the same SQL; see [Orders workspace](orders-workspace.md).

## Operational registry (v2)

The v2 registry lists the order v1 definitions plus the domain-owned v2 families. A v2 query
requires `definitionVersion: 2` and an explicit `metrics` list, and reads only the selected
families. Each cohort is typed by `kind`.

| Metric                              | Unit           | Predicate                                                                                                       |
| ----------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| `cases.active`                      | case           | Distinct unresolved incidents, across all subjects                                                              |
| `cases.attention`                   | case           | The inbox projection, with exclusive approval/manual intervention/uncertainty reasons                           |
| `cases.oldest_unresolved_age`       | second         | Maximum age since first detection; keeps first detection after reopening                                        |
| `inventory.below_minimum`           | stock position | Active-rule positions whose configured-source stock passes the replenishment plan check and is below minimum    |
| `inventory.replenishment_unknown`   | stock position | Active-rule positions with absent, deleted, nonnumeric, invalid-time, future or expired configured-source stock |
| `procurement.purchase_orders.draft` | purchase order | Exact current draft status, distinct persisted IDs                                                              |
| `procurement.purchase_orders.open`  | purchase order | Exact current open status, distinct persisted IDs                                                               |
| `connections.needing_attention`     | connection     | Pending, degraded or revoked, or active with stale or unobserved permitted granted reads; excludes disconnected |

The `resolution.*` family uses the same request; its rules are in
[resolution measurement](resolution-measurement.md).

Filters: inventory and connection metrics accept `connectionId`; procurement accepts
`supplierId` and `authority`; resolution accepts `environment` and a `24h` or `7d`
first-detection `window`; cases accept none. Every selected metric must support every
supplied filter, so use separate requests when families need different scopes.

- An empty case cohort has age `null`. Missing or future detection times make the maximum
  unknown (`value: null`, `unknownCount > 0`) while the oldest valid incident stays
  inspectable.
- Stock below minimum has `total: null` when unusable positions prevent a complete total; the
  unknown-stock metric counts that cohort exactly. No active rules means unavailable
  inventory coverage, not healthy inventory. `population` counts active-rule positions, never
  quantities or all warehouse SKUs.
- Stock commitments share the workflow predicate: any draft or open purchase order with the
  exact rule SKU, across suppliers and inventory sources. Commitments do not establish
  acceptance, sufficient incoming quantity or receipt.
- Supplier names on purchase orders are the persisted recorded names, so the supplier table
  is not a metric dependency.

## Page summary

`POST /v2/organizations/:organizationId/metrics/summary` reads up to four parts in one request.
Each part is an order (v1) or operational (v2) query and follows that endpoint's rules. Parts
return in request order with their own status: a failing part, such as a 404 for an unknown
connection or a 403 without `orders.read`, carries its error while the others succeed. Each part
returns its first cohort page; page a part through its own query endpoint. `nextRefreshAt` is the
earliest boundary across the parts that were read.

## Consistency and paging

Every count and cohort in a response uses the same facts inside one read-only, repeatable-read
transaction, including coverage and case attention. `asOf` is the evaluation time for deadlines
and expiry, and every request evaluates at its own read time.

Full cohorts determine the counts before paging. Each metric returns a page of 20 records by
default and up to 100, with `offset` (records paged past) and `nextCursor`. Passing a metric's
`nextCursor` as `cursor` reads the records after the last one returned, in a fixed order per
record type: orders and cases by ID, purchase orders by creation time, resolution outcomes by
first detection, stock by SKU and connections by label, each with the ID as a tiebreaker.
Other metrics in that request return their first page.

Pages read current data, so a busy workspace never invalidates a later page. Records that join
or leave a cohort don't shift the pages after them, but a record whose sort value changed can
appear twice or not at all; clients deduplicate by ID, and `offset` only labels the page. A
cursor names its metric and sort position; it is not an access credential, and authorization
runs on every request.

v1 `updatedFrom`/`updatedBefore` select accepted source update instants in `[from, before)`.
Bounds must carry an offset; no browser time zone is inferred. Missing source update times
are excluded when either bound is set. These filter current state; they are not historical
event counts. v2 rejects historical windows except the resolution window.

Saved dashboard specifications keep the definition version and validated scope. Unknown
properties, executable code, unsupported versions, invalid windows and excessive limits are
rejected. Foreign and nonexistent connection filters both return 404, and RLS also isolates
records and mappings.

## Coverage and time

Observation freshness does not prove a complete scan. Ingestion has no authoritative
order-and-fulfillment scan watermark, so order `total` and `dataThrough` are null and
`observedCount` is the known matching cohort, not a complete business total. Order coverage is
`partial` when scoped canonical orders exist and `unavailable` otherwise. An empty known cohort
never establishes a complete zero, and unknown classification cannot quantify unobserved
orders. Cases and procurement have complete coverage within their recorded scope. Connection
coverage measures permitted read freshness, not provider record completeness; a latest
observation never becomes a scan watermark.

`observedAt` is the latest nonfuture selected observation. Fresh means every selected order was
observed within 24 hours and every monitored connection in scope has fresh granted reads;
otherwise data is stale or unobserved. Future observations establish neither state nor
freshness. Failures and offline states hide previous counts.

Counts change without writes as time passes. Responses carry `nextRefreshAt`: the earliest
future deadline, freshness, attention, diagnosis or proposal expiry across the whole
population, not just the visible page. Stock expires exactly five minutes after observation,
and future stock becomes eligible at its observation time. A refresh at most every 60 seconds
advances case and purchase-order ages.

## Live delivery

Home and Insights subscribe to `/v1/organizations/:organizationId/metrics/events` before
their first metric read, and each page reads all of its metric sections through one
[page summary](#page-summary) request. A `resync` frame with `refetch: true` lists the changed
`topics`; a page reads again, through the normal authorized query, only when a topic one of
its sections depends on is listed. Overview metrics,
Insights charts and Needs you share one subscription per browser page, which closes after its
last consumer unmounts.

### Notifications

Every table a metric reader depends on carries an INSERT, UPDATE and DELETE trigger that
names the areas it affects. The payload on `luma_metrics` is `tenant:topic,topic`, with no
record data; a bare tenant UUID means every area changed. PostgreSQL delivers notifications only after
commit, so a rollback delivers nothing, and identical payloads within one transaction
coalesce. There is no outbox or replay cursor: canonical state is durable, and any reconnect
reads current state. `Last-Event-ID` does not select a replay position.

Traps:

- A new reader dependency must extend the trigger list with its topics, or its changes
  appear only at the next reconciliation. The migration that maps tables to topics fails if
  a `metric_change` trigger names no topic.
- TRUNCATE is not a supported canonical write path; administrative imports must use normal
  writes or force reconciliation.
- Invalidation is per tenant, not per row, to keep the shared count/cohort snapshot
  consistent. Row triggers favor complete write-path coverage over minimum write overhead.

### Topics

`workspaceTopics` in the API contract lists the areas: `orders`, `connections`, `issues`,
`inventory`, `workflows`, `procurement`, `resolution`, `decisions` and `messaging`. Every table that feeds
Needs you also carries `decisions`. Each consumer declares its topics: order metrics use
orders, issues and connections; operational metrics use issues, inventory, procurement and
connections; resolution outcomes use issues, resolution and connections. A view that reads a
new table must subscribe to that table's topic. Listener reconnection, the first frame of a
stream, a consumer joining an open stream and the 30-second reconciliation list every topic.

### Listener and recovery

Each API process owns a dedicated listener connection, separate from the query pool, and
LISTENs independently. Reconnection backs off from 100 ms to 10 seconds, and a completed
LISTEN broadcasts a reconciliation request. A stream opened while the listener is down
reports degraded delivery and still permits authorized reads. Every stream also reconciles
every 30 seconds, which repairs a lost wake-up.

The browser marks delivery interrupted after 12 seconds without a heartbeat, reconciles every
30 seconds while delivery is unavailable, reconnects with a backoff from one to 10 seconds,
and opens a new subscription when it comes back online. A page loads as soon as the stream
opens; later changes are throttled to one summary read per two seconds, where the first
change after a quiet period reads at once and a burst reads again when the interval ends.
Reads are serialized and cancel older requests. The first cohort page follows live refreshes;
a later page stays in place, and once the metric's count changes the dialog offers to show the
latest records. Refresh returns to the first page. A refresh shows progress only after it has
run for 10 seconds, and controls stay usable while reads run. The UI keeps delivery state (live, reconnecting, offline, denied)
separate from source observation age, stale source data and partial coverage. A live stream
does not prove complete provider coverage.

### Stream access and bounds

Any workspace member may open the stream. Each topic requires its area's read permission
(`orders.read`, `issues.read`, `inventory.read`, `workflows.read`, `procurement.read`,
`messages.read` for messaging, and `insights.read` for resolution); `connections` and `decisions` go to every member because
their readers filter records themselves. Changes only in unreadable areas send nothing.

The session and membership are resolved again on the five-second heartbeat and before any
frame whose last check is older than five seconds, so a burst costs one authorization read.
Denial closes the stream, and the browser confirms through an authenticated query
and removes the metric cache on 401, 403 or 404. A stream lives five minutes. Changes coalesce
over 75 ms with at most one authorization read in flight and one pending invalidation per
stream. Each API process allows 100 streams, three per workspace and user (429 beyond),
eight concurrent authorization reads and 100 queued (503 beyond). A failed socket write
closes a slow consumer immediately; no per-client queue is kept. Shutdown closes all streams
and the listener.

### Operating the listener

- `pg_stat_activity` should show one `application_name = 'luma-metric-listener'` per API
  process.
- A transaction-pooling proxy cannot hold LISTEN state; use a direct or session-pooled
  database URL.
- If delivery lags, inspect `pg_notification_queue_usage()` and keep long transactions off
  listener connections.
- Restarting an API, terminating its listener or losing a browser connection must produce a
  fresh authorized read. Never repair a count by replaying messages.

## Limits

Each metric statement has a 3-second timeout; a timeout fails the request rather than
returning a partial calculation as a complete answer. The runtime's metric query pool has
five connections. No metric maintains an aggregate table: order reads over a 10,000-order,
two-connection fixture took under 200 ms per statement, so a durable projection with its
rebuild machinery was not justified. Larger orders with many lines, long source histories,
many connections or many attention links need new measurements before raising traffic
limits. `LUMA_METRIC_BENCHMARK=1` on the commerce integration suite records order query plans.

The v2 readers materialize scoped cohorts in server memory before paging, so memory and query
cost grow with the workspace population. They were checked with about 200 cases, stock
positions and rules and 60 purchase orders; the stock projection join is the most expensive
reader.

Browser tests enforce these budgets and write their measurements to `.luma/performance`:

- Commit to visible count p95 below one second, with two API instances, six subscribers and
  sequential writes (`metric-live.browser.mjs`). Frames stay under 4 KiB, and subscribers
  receive under 128 KiB in that run.
- At most 12 SQL statements per cross-domain summary read (`operational-metrics.browser.mjs`).

Not measured: saturation at the 100-stream limit, internet latency, concurrent writers or
large tenants. Source observation age is not a provider-to-Luma ingestion delay.
