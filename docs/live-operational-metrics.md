# Live operational metrics

Overview subscribes to `/v1/organizations/:organizationId/metrics/events` before
its first metric query. A `resync` frame with `refetch: true` invalidates the
workspace's active order metrics and cohort. Counts always come from the shared,
authorized PostgreSQL query. Events never increment counters.

## Commit and recovery

Migration `0031_metric_notifications.sql` installs INSERT, UPDATE and DELETE
triggers on every table used by the order, attention and coverage readers:

- Orders: projections, snapshots and relationships.
- Connectors: source mappings, installations, observations and read checks.
- Attention: exceptions, diagnosis heads, diagnoses, uncertainty, case commands,
  proposals, policy decisions and approvals.

These cover ingestion, corrections, tombstones and physical deletes. The trigger
emits only a tenant UUID on `luma_metrics`. PostgreSQL delivers notifications only
after commit; a rollback delivers nothing. Repeated payloads within one transaction
coalesce. No outbox consumer or cursor is added: canonical state remains durable,
and reconnect reads current state. Existing domain outboxes retain their existing
acknowledgement and retry semantics. TRUNCATE is not a supported canonical write
path; administrative imports must use normal writes or force reconciliation.

Each API runtime owns a dedicated `pg.Client`, separate from the query pool. Every
instance LISTENs independently. Reconnection backs off from 100 ms to 10 seconds;
a completed LISTEN broadcasts a reconciliation request. A stream opened while the
listener is unavailable reports degraded connectivity and still permits authorized
reads. Changes before LISTEN or during downtime are recovered by the next snapshot.
`Last-Event-ID` does not select a replay cursor.

## Bounds and access

Streams coalesce changes over 75 ms, with at most one authorization read in flight
and one pending invalidation per stream. Each API permits 100 streams, three per
workspace/user, eight concurrent stream authorization reads and at most 100 queued
reads. The runtime's metric query pool has five connections; SQL statements retain
the three-second metric timeout.

The original cookie session and membership are resolved before every frame and on
a five-second heartbeat. Denial closes the stream. The browser confirms failure
through an authenticated query and removes the metric cache on 401/403/404. Normal
metric reads also pass through the identity guards. A stream lifetime is five
minutes. Shutdown clears subscriptions and closes the listener.

A false socket write closes a slow consumer immediately; no per-client event queue
is retained. EventSource reconnects after one second and requests a fresh snapshot.
The client serializes invalidation reads and cancels older requests before fetching
new current state. Changes during a read schedule one subsequent read. A change
while paging returns the cohort to page one, preserving the selected metric and
open dialog.

## Time and freshness

`nextRefreshAt` is the earliest future deadline or freshness/attention expiry from
the whole result population, including orders outside the visible page. The client
schedules a refresh at that boundary. Diagnosis and proposal expiry are included.
The server reconciles every 30 seconds; the browser also reconciles every 30 seconds
when delivery is unavailable. A missing heartbeat for 12 seconds marks delivery
interrupted. Browser online recovery creates a new subscription.

The UI distinguishes live delivery, reconnecting, offline and denied access from
source observation age, stale source data and partial coverage. A live stream does
not establish complete provider coverage. Source observation age is measured from
the latest accepted observation to the authoritative read time; it is not internal
commit-to-visible latency or proof of a complete scan.

## Operations and validation

Check `pg_stat_activity` for `application_name = 'luma-metric-listener'` and one
listener per API process. A transaction-pooling proxy cannot retain LISTEN session
state; use a direct or session-pooled database URL. Inspect
`pg_notification_queue_usage()` if notification delivery is delayed. Keep long
transactions off listener connections.

Restarting an API, terminating its listener, or losing a browser connection must
produce a fresh authorized read. Do not repair a count by replaying messages.

Run `pnpm test:e2e metric-stream.e2e.mjs` and
`pnpm test:browser metric-live.browser.mjs metrics.browser.mjs`.
The stream unit tests prove subscription-before-read ordering, a concurrent initial
change and slow-consumer cleanup. The database suite covers two API instances,
rollback, duplicate wake-ups, burst coalescing, trigger coverage, tenant isolation,
listener/API downtime and session/membership loss. Browser tests cover visible
counts and cohorts, fulfillment, correction, deletion, time without writes, source
failure, disconnection and cache clearing.

Measurements and tradeoffs are recorded in
[the workload report](live-operational-metrics-performance.md).

References: [PostgreSQL LISTEN ordering](https://www.postgresql.org/docs/current/sql-listen.html),
[transactional NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html),
[pg client notifications](https://node-postgres.com/apis/client).

## Cross-domain metrics

Migration `0032_operational_metric_notifications.sql` adds the same transactional
wake-up trigger to inventory entities, snapshots and projections, replenishment
activations and purchase orders. Inserts, corrections, deletes, revocations and PO
transitions invalidate both versions through the existing tenant SSE stream. Mapping,
case, diagnosis, policy and connection tables remain covered by migration 0031.
Rollback sends no notification. Supplier names shown on POs are their persisted
recorded names, so the supplier table is not a metric dependency.

V2 supplies per-metric and response-wide `nextRefreshAt`. Stock expires exactly at
five minutes; future stock becomes eligible for reassessment at its observation time.
Case diagnosis/proposal boundaries and the connection 24-hour-plus-one-millisecond
boundary reuse existing readers. A maximum 60-second age refresh advances case and
PO ages without writes. The shared browser hook subscribes before reading, serializes
invalidations, resets pagination, hides inaccessible/offline results, and retains the
existing reconnect and polling recovery. The operational summary and order v1 panel
use separate family requests and share one tenant subscription per browser page.
The subscription closes after its last consumer unmounts. Online recovery and
stream retries reopen that single connection for all consumers.
