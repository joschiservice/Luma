# Cross-domain metric measurements

Measured locally on 2026-09-28 using PostgreSQL 17 in Testcontainers, two Node API
instances and Chromium. Run `pnpm test:browser operational-metrics.browser.mjs` to
reproduce. The test writes raw timings and EXPLAIN JSON to
`/tmp/luma87-performance.json` and desktop/mobile/cohort images to `/tmp/luma87-ui`.

## Dataset and concurrency

The fixture contains 200 unresolved workflow-subject incidents, 200 canonical stock
positions and active rules, 200 inventory observations, one installed connection and
40 initial draft POs (two same-SKU lines each). Twenty measured PO creations and one
replacement leave 61 recorded POs: 60 drafts and one cancellation. Subsequent checks
revoke one rule, delete one projection and expire another observation. Query plans
below reflect that final state: 199 active rules, 199 projections and 61 POs.

Seven concurrent SSE subscriptions run across two API instances. Five background
subscribers and the summary panel query all eight v2 metrics on changes. The seventh
subscription belongs to the order v1 panel. Writes are sequential, with each next
write following visible confirmation; this is not a saturation or production-scale
benchmark. Background HTTP reads had p95 55.7 ms
across 135 samples.

## Commit response to visible count

Twenty real PO create commands were timed from receipt of their successful committed
HTTP response to the browser showing the new draft count (20 ms assertion polling).
This excludes response transit between database commit and the command returning;
it is a local commit-response-to-visible approximation, not database commit-clock
instrumentation. Other repository checks also ran on the same host.

| Measure | Milliseconds |
| ------- | -----------: |
| p50     |        141.7 |
| p95     |        143.4 |
| Maximum |        155.6 |

This run meets the under-one-second target at the stated load. It does not establish
an upper bound for larger tenants, WAN connections or higher write concurrency.

## Query plans

Captured with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` around the actual public readers
in one repeatable-read transaction, using the fixture administrator connection.
HTTP and browser checks separately exercise restricted runtime roles and tenant access.
These are warm local plans; no explicit ANALYZE was run after fixture insertion.
Execution times are individual PostgreSQL queries, not whole HTTP latency.

| Reader                        | Root operation | Rows | Execution ms | Shared hits |
| ----------------------------- | -------------- | ---: | -----------: | ----------: |
| Inbox case projection         | Unique         |  200 |        0.830 |         427 |
| Diagnosis/proposal boundaries | Aggregate      |    1 |        0.049 |           8 |
| POs for commitments           | Sort           |   61 |        0.070 |          15 |
| Replenishment rules           | Sort           |  200 |        0.137 |          22 |
| Configured stock projections  | Sort           |  199 |       15.705 |        3165 |
| PO backlog                    | Sort           |   61 |        0.072 |           9 |
| Permitted connection coverage | Sort           |    1 |        0.646 |         191 |

The case reader reuses the inbox projection, then deduplicates incident IDs. Inventory
uses the existing projection/snapshot/SKU joins; the largest read in this fixture is
that stock join. Procurement is read once for commitments and once for its selected
backlog family. There is no dashboard cache. Readers materialize compact scoped
cohorts before pagination; memory and query costs grow with the workspace population.
The common three-second statement timeout bounds individual database statements.

The same journey checks page reconciliation, focus restoration, an in-flight read
race, case attention changes, PO open/cancel transitions, commitment links, rule
revocation, projection deletion, stock expiry without writes, offline recovery and
session loss. The order v1 API/browser regressions and shared stream rollback,
subscription, listener recovery and access-loss tests remain separate gates.
