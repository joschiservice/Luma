# Shared operational metrics

The overview exposes three version 1 metrics: `orders.open`, `orders.overdue`
and `orders.attention`. Select **Inspect orders & definition** to see the rule,
known matches, unknown classifications, source coverage and observation times.
Counts are calculated on the server. The browser never counts a loaded page.

## Counting rules

The counting unit is a canonical order ID from `orders_entities`. Explicit source
mappings reconcile provider orders and lines; matching display numbers never
establish identity. Without a connection filter, the accepted order snapshot with
the latest source-update time wins (null timestamps last), then latest observation,
then connection ID. This deterministic selection does not imply that providers
have synchronized clocks. A connection filter selects that source before this
choice. Fulfillment quantities come only from the selected connection, preventing
mirrored shipments from being added twice.

- **Open:** a nondeleted order has status `open` and at least one line has positive
  remaining quantity: ordered minus cancelled minus completed/shipped/delivered
  fulfillment quantities. Partial fulfillment counts once. Pending, processing,
  failed, cancelled and deleted fulfillments do not reduce remaining work.
  Completed or cancelled orders never count, including cancellation after shipment.
  A newer accepted open snapshot can reopen an order if work remains. Empty lines,
  unknown statuses and missing cancellation quantities produce unknown classification
  unless another line establishes remaining work or fulfillment covers all units.
- **Overdue:** an open order has a source-provided `dueAt` strictly before `asOf`.
  Equality is not overdue. Missing deadlines are unknown for open orders. Providers
  may supply the optional deadline through the observation contract; ingestion
  preserves it without deriving promises from receipt times. Existing adapters
  without a deadline therefore produce unknown overdue classifications.
- **Attention:** a nondeleted order has at least one mapped fulfillment issue
  satisfying the inbox's persisted approval, manual-intervention or uncertainty
  rules. Multiple issues count the order once. Source-local fulfillment IDs are
  resolved through explicit connection mappings with an empty scope, matching the
  current fulfillment subject contract. Unlinked workflow, stock and connection
  issues do not imply order-level attention. Issue links explain each match.

Accepted projections remain authoritative: duplicate replay is idempotent, older
source revisions are retained in history but do not replace current state, and
newer corrections replace it. Reading history by observation time would incorrectly
revive rejected source updates. No metric maintains a second aggregate projection.

LUMA-80 continues to own verified outcome eligibility and human-work attribution.
Those facts are not available yet and are not fabricated or registered as order
metrics.

## API and consistency

`GET /v1/organizations/:organizationId/metrics` returns the registry.
`POST /v1/organizations/:organizationId/metrics/query` accepts:

```json
{
  "definitionVersion": 1,
  "scope": { "connectionId": "a-connection-uuid" },
  "limit": 20,
  "offset": 0
}
```

Omit `scope` for all workspace connections. Optional `updatedFrom` and
`updatedBefore` select accepted order source-update instants in the half-open
interval `[from, before)`. Missing source-update times are excluded when either
bound is present. Bounds must be offset-qualified timestamps; no browser timezone
is inferred. The response uses UTC instants and the UI formats them in the workspace
timezone. These are current-state filters, not historical event counts.

The response contains all three definitions, known counts, unknown counts and up
to 100 matching records per metric. Every count and cohort uses the same facts
inside one read-only PostgreSQL repeatable-read transaction, including coverage
and case attention. `asOf` freezes deadline and attention-expiry evaluation;
`readAt` identifies the actual read time. An initial request chooses its own `asOf`.

Reuse `asOf` and `snapshot` for subsequent pages. Offsets are bounded at 10,000.
The snapshot fingerprint binds tenant, definition version, filters, evaluation
time, canonical facts and coverage. Changed records return `409`; restart at
zero. Tokens expire after 15 minutes. They are consistency checks, not access
credentials or historical snapshots. Authorization runs on every request.

Saved dashboard specifications can retain the definition version and validated
scope. Unknown properties, executable SQL/JavaScript, unsupported versions,
invalid windows and excessive limits are rejected. Workspace members can read
all workspace order dimensions under the existing membership model. Foreign and
nonexistent connection filters both return `404`. PostgreSQL RLS also isolates
records and source mappings. No connector credential columns are granted.

## Coverage and time

Observation freshness does not prove a complete scan. Current ingestion has no
persisted authoritative order-and-fulfillment scan watermark, so `total` and
`dataThrough` are null. `observedCount` always reconciles with the known matching
cohort; it is not a complete business total. Coverage is `partial` when scoped
canonical orders exist and `unavailable` otherwise. Empty known matches never
establish a complete zero. Unknown classification is separate from missing source
coverage; it cannot quantify unobserved orders.

`observedAt` is the latest nonfuture selected order observation. Freshness requires
all selected orders to have observations within 24 hours and all monitored scoped
connections to have fresh granted reads. Otherwise it is stale or unobserved.
Future observations do not establish current order state or freshness. Failures
and offline states hide previous UI counts.

A new evaluation can become overdue solely because time passes. Pagination holds
the evaluation time fixed. LUMA-85 owns live scheduling and invalidation; this
feature supports explicit refresh and refresh on focus/reconnect.

## Storage and validation

Definitions live in `packages/orders/src/domain/metrics.ts`; canonical SQL is in
`orders/src/infrastructure/metrics.ts`. The exceptions owner shares its existing
attention query. Resolution composes public readers within one transaction.
Migration `0030_order_metric_reads.sql` adds tenant-scoped read grants and a
connection index. Each statement has a three-second timeout; attention linking
also has a 10,000-record bound and fails rather than truncating a total.

Run `pnpm test` for commerce integration coverage and
`pnpm test:browser metrics.browser.mjs` for authenticated desktop/mobile coverage.
The commerce fixture covers partial/full fulfillment, cancellation, reopening,
correction, duplicate delivery, out-of-order updates, mirrored identities,
deadline boundaries, unknown dates, filters, tenant isolation and snapshot changes.
Set `LUMA_METRIC_BENCHMARK=1` when running that PostgreSQL suite to generate
`/tmp/luma84-query-plans.json` with EXPLAIN ANALYZE/BUFFERS plans and five samples.
See [query measurements](operational-metrics-performance.md).

## Current operational registry (v2)

`GET /v2/organizations/:organizationId/metrics` lists the order v1 definitions
and eight domain-owned v2 definitions. Order v1 request/results remain unchanged.
`POST /v2/organizations/:organizationId/metrics/query` requires
`definitionVersion: 2` and explicit `metrics`. It reads only selected families.
The v2 cohort is discriminated by `kind`: `case`, `stock_position`,
`purchase_order`, or `connection`.

| Metric                              | Unit           | Scope and predicate                                                                                             |
| ----------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| `cases.active`                      | case           | Distinct unresolved incidents, across all subjects                                                              |
| `cases.attention`                   | case           | The inbox projection, with exclusive approval/manual intervention/uncertainty reasons                           |
| `cases.oldest_unresolved_age`       | second         | Maximum age since first detection; retains first detection after reopening                                      |
| `inventory.below_minimum`           | stock position | Active-rule positions whose configured-source stock passes `planReplenishment` and is strictly below minimum    |
| `inventory.replenishment_unknown`   | stock position | Active-rule positions with absent, deleted, nonnumeric, invalid-time, future or expired configured-source stock |
| `procurement.purchase_orders.draft` | purchase order | Exact current draft status, distinct persisted IDs                                                              |
| `procurement.purchase_orders.open`  | purchase order | Exact current open status, distinct persisted IDs                                                               |
| `connections.needing_attention`     | connection     | Pending/degraded/revoked, or active with stale/unobserved permitted granted reads; excludes disconnected        |

Cases and procurement have complete coverage within their recorded workspace scope.
An empty case cohort has age `null`; missing/future detection times make the maximum
unknown (`value: null`, `unknownCount > 0`), while the oldest valid incident remains
inspectable. Count metrics use `value` for known matches. Stock below minimum has
`total: null` when unusable positions prevent a complete total. The unknown-stock
metric counts the unusable cohort exactly. No active rules means unavailable
inventory coverage, not healthy inventory. `population` counts active-rule positions,
never quantities or all warehouse SKUs.

Stock commitments share the workflow predicate: any draft/open PO with the exact
rule SKU, across suppliers and inventory sources. Each position links distinct PO
IDs. Commitments do not establish acceptance, sufficient incoming quantity, or
receipt. PO status and authority do not establish a complete external supplier sync.
Connection coverage measures permitted read freshness, not provider record completeness.
`dataThrough` stays null; a latest observation never becomes a scan watermark.

Inventory and connection metrics accept `connectionId`. Procurement accepts
`supplierId` and `authority`. Cases accept no filters. Every selected metric must
support every supplied filter; unsupported fields and historical windows are rejected.
Use separate requests when families need different scopes.

Composition injects public Exceptions, Procurement and Connections readers into a
single authorized repeatable-read transaction. Definitions and business predicates
stay with those owners. Full compact cohorts determine counts and the SHA-256
snapshot before transport pagination (20 default, 100 maximum). Snapshot hashes bind
the tenant, metric selection, filters, evaluation time and results. Reuse `snapshot`
and `asOf` for pages; changes or snapshots older than 15 minutes return 409.
The readers materialize scoped cohorts in server memory; query plans and the measured
load boundary are recorded in [cross-domain measurements](operational-metrics-cross-domain-performance.md).
