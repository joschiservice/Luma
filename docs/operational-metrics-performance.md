# Order metric query measurements

Measured on 2026-09-28 using disposable PostgreSQL 17 Alpine in local Docker,
with the restricted tenant runtime role and RLS enabled. These are development
measurements, not production capacity guarantees.

## Fixture and method

The commerce integration fixture seeds 10,001 canonical orders across two source
connections, including one mirrored order, accepted/rejected historical revisions,
fulfillment records and one mapped attention issue. Every order has one line.
The response requests 20 records for each of the three metrics.

The opt-in `LUMA_METRIC_BENCHMARK=1` fixture executes five
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` samples, followed by 25 complete service
reads in five batches of five concurrent requests. Full service reads include
connection coverage, attention linking, the order query, snapshot hashing and
transaction overhead. Raw plans are written to `/tmp/luma84-query-plans.json`.

| Measurement                                  |                               Result |
| -------------------------------------------- | -----------------------------------: |
| Order SQL execution, five samples            | 192.4, 149.0, 170.7, 143.8, 140.8 ms |
| Complete service read, concurrency 5, median |                             183.2 ms |
| Complete service read, concurrency 5, p95    |                             209.0 ms |
| 25 reads, wall time                          |                             971.7 ms |
| Observed throughput                          |                    25.7 reads/second |

## Representative plan

```text
Result: one bounded JSON response
  selected: Unique -> Sort -> Hash Join
    Seq Scan orders_snapshots, tenant + kind filter
    Seq Scan orders_projections, tenant filter
  scoped: CTE Scan selected, optional update-time bounds
  fulfilled: Aggregate -> Nested Loop
    current fulfillment snapshots + scoped canonical orders
    Index Scan orders_projections using orders_projection_connection
  classified (materialized): CTE Scan scoped
    per-order line remainder aggregate
    persisted attention order links
  rows (materialized): cohort flags and display facts
  revision: sorted aggregate over canonical rows
  metrics: three bounded count/unknown/page aggregates
    Limit -> Sort -> CTE Scan rows
```

The planner uses sequential scans for the all-tenant fixture because most rows
belong to that tenant; forcing an index would not establish better performance.
Existing tenant/entity snapshot indexes support canonical joins. Migration 0030
adds a tenant/connection/entity index for scoped reads.

The first measurement exposed repeated evaluation of line classification after
CTE inlining. Materializing that intermediate result evaluates it once per order.
Counts and cohorts still share the same predicates. No durable aggregate table
was justified by this bounded workload, so no rebuild/checkpoint subsystem was
introduced.

Larger orders with many lines, long source histories, many connections or many
attention links need separate measurements before increasing traffic limits.
Each statement is capped at three seconds; results are limited to 100 records per
metric and offsets to 10,000. A timeout fails the request rather than returning a
partial calculation disguised as a complete answer.
