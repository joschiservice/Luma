# Live metrics workload and recovery

Measured on 2026-09-28 with Node 24, PostgreSQL 17 in Testcontainers and Playwright
Chromium on local macOS. Raw samples are stored with the runtime in
[`measurements/live-metrics.json`](../packages/application-runtime/measurements/live-metrics.json).
Reproduce with `pnpm test:browser metric-live.browser.mjs` and
`pnpm test:e2e metric-stream.e2e.mjs`.

## Recorded result

| Measurement                                           |  Result |
| ----------------------------------------------------- | ------: |
| Canonical writes/second                               |    4.03 |
| Commit to visible count, p95                          |  222 ms |
| Metric HTTP read, p95                                 |   42 ms |
| Subscriber HTTP read, p95                             |  124 ms |
| Browser recovery                                      |   94 ms |
| Listener recovery                                     |  217 ms |
| Latest source observation age                         | 11.62 s |
| Invalidations per instance for 100 committed wake-ups |    1, 1 |

## Workload

- 200 canonical orders, each with one line, seeded through commerce ingestion and mapping.
- Two API runtimes, each with its own PostgreSQL listener and query pool.
- Six concurrent subscriptions. One Chromium page renders counts and cohorts; five
  clients perform authenticated HTTP metric reads on invalidations.
- Twenty alternating cancellation/reopening commits. Each commit is followed by a
  DOM assertion and an additional authenticated metric read before the next write.
- A separate burst of 100 committed notifications verifies bounded invalidations per instance.

The raw artifact records observed writes/second, all commit-to-visible samples,
p95 metric HTTP read duration, p95 subscriber read duration, listener reconnect
time and browser recovery time. Commit-to-visible starts when the canonical
transaction's COMMIT has returned and ends when Chromium observes the expected
count. Its 20 ms assertion interval adds measurement overhead. HTTP read duration
includes authorization, SQL, serialization and transport; it is not SQL-only cost.

The target is p95 below one second. The workload test asserts that target. Source
observation age is recorded separately from internal delivery and remains visible
when delivery is live but connector coverage is stale or degraded. Observation age
is not a completeness watermark or a measured provider-to-Luma ingestion delay.

## Recovery evidence

The tests terminate both PostgreSQL listeners, write during the gap and verify
degraded frames followed by a reconnect invalidation and authoritative totals.
They also stop/recreate an API and change state while it is down. A disconnected
browser receives a fresh result after reconnecting. Initial-read races retain a
pending invalidation; delayed old HTTP responses cannot overwrite a newer result.

Rollback yields no notification. Duplicate signals cannot alter counts. Reads and
streams reject other tenants. Membership and session revocation close streams and
hide the browser cache. Slow consumers are disconnected; unit tests verify cleanup
and the eight-read authorization concurrency limit. Deadline refreshes cover the
whole cohort, including orders beyond the first page, without another mutation.

## Tradeoffs

This is a representative pilot workload, not a saturation benchmark. Twenty
samples and one locally rendered browser do not establish internet latency or
capacity at the 100-stream limit. The other five clients do perform full reads.
The sequential write pattern intentionally makes each visible result measurable;
it does not model unlimited producer throughput.

75 ms coalescing adds a small bounded delay to reduce duplicate reads. A tenant's
whole order-metric scope invalidates rather than individual rows, preserving the
shared count/cohort snapshot. Row triggers favor complete write-path coverage over
minimum per-row write overhead; PostgreSQL folds identical tenant payloads within
each transaction. New canonical reader dependencies must extend the trigger list.

A lost wake-up is repaired by 30-second reconciliation. Listener errors are exposed
immediately; silent transport loss is marked after the 12-second heartbeat window.
Access is checked before every frame and at least every five seconds. Freshness and
deadline timers are relative to the server read time; no durable timer is needed
when no view is subscribed. New database state is always reread on subscription.
