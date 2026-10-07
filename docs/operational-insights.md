# Operational insights charts

Insights charts show orders, fulfillment backlog, stock risk, issues and purchase orders
over a calendar window or as current state. Every point opens the records it counts. A chart
and its record list are computed by the same rules, so their totals agree when they are read
at the same evaluation time.

## Charts and rules

| Chart         | Unit               | Kind      | Placement and series                                                                                                                                               |
| ------------- | ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orders`      | canonical order    | timeline  | Source `placed_at` in the bucket; series is the current status. Without a source filter the `selected` `orders_list` row counts, so linked orders count once.      |
| `fulfillment` | source fulfillment | breakdown | Open work from the Fulfillment workspace rules (`fulfillment/rules.ts`), by hours since `progress_at`; series is the first of held, overdue, stalled, else `none`. |
| `stock`       | stock position     | breakdown | `classifyStockPositions` from the procurement owner: unknown stock, below minimum with or without a draft/open purchase order, or at/above minimum.                |
| `cases`       | issue              | timeline  | First detection from the exceptions owner's `caseTimelineQuery`; series is the issue class. Reopened issues keep their first detection.                            |
| `procurement` | purchase order     | breakdown | Stage from the procurement owner's `summaries`, excluding closed and cancelled; series is whether a confirmation or delivery is overdue.                           |

Timelines never reconstruct states. Statuses are current, and breakdowns describe only the
evaluation time. Resolution performance stays in [resolution measurement](resolution-measurement.md).

Buckets are calendar days or Monday-based weeks in the requested IANA time zone, computed in
PostgreSQL. The last bucket ends at the start of the next local day. Orders reconcile with the
Orders list: a point's `start`/`end` days are the list's `placedFrom`/`placedTo`, and its series
is the list's `status`.

## Coverage and data-through time

Commerce charts list each in-scope connection with its `commerce_sync_streams` state:
`complete`, `limited` (history starts after the window starts), `importing`, `stale` (no
complete read for 24 hours), `failing`, `paused`, `disconnected` or `not_synced` (records
arrive only as observations). `dataThrough` is the oldest stream `watermark`; it is null when
any source never completed a read. A timeline point lying wholly before every source's
`history_from` is `not_imported`, which the UI draws as unknown, never as zero. A point that
starts before some history or ends after `dataThrough` is `partial`.

Issue and purchase-order charts read Luma's own records: their coverage is complete and
their data-through time is the evaluation time. Stock coverage is unavailable without active
rules and partial while any monitored position has unusable stock.

The orders chart returns 503 while an existing tenant's order-list projection awaits
[backfill](orders-workspace.md#backfill-and-rollout). This marker requires the rebuild command;
repeating the chart request does not advance it.

Charts share the workspace metric stream and refresh for the orders, issues, inventory,
procurement, workflows and connections topics. Live invalidations read at most once per two seconds and
let active reads finish before processing further changes. After a failed read, stream
events cannot start another attempt for 30 seconds. Explicit refresh, filter changes,
focus and reconnect still request current data. Failed charts hide earlier values.

## API

`GET /v1/organizations/:organizationId/insights/:chart` accepts `range` (`7d`, `30d`, `13w`),
`timeZone` and `connectionId`. `GET …/insights/:chart/records` adds `point`, `series`, `asOf`,
`offset` and `limit` (at most 100). Records require an `asOf` no older than 15 minutes, so a
chart's time-based rules (stall window, overdue) classify records the same way. Any workspace
member can read charts; tenant row security scopes every query.

## Code

- Contracts: `packages/api-contract/src/insights.ts` and `contracts/insights.ts`.
- Read model: `packages/read-models/src/infrastructure/insights` (`workspace.ts` composes
  `orders.ts`, `fulfillment.ts`, `cases.ts`, `current-state.ts`, `window.ts`, `coverage.ts`);
  pure rules in `domain/insights.ts`; routes in `api/insights.ts`.
- Owner inputs: `caseTimelineQuery` in `packages/exceptions/src/infrastructure/cases.ts`,
  `createStockRiskReader` in `packages/procurement/src/infrastructure/metrics.ts`, and the
  commitments `summaries` joined with purchase orders in
  `packages/application-runtime/src/composition/application.ts`.
- Web: `apps/web/src/features/insights` (`charts.tsx` section, `chart-card.tsx`,
  `records.tsx` drilldown sheet, `presentation.ts` wording, `data.ts` URL state and queries).
  The chart primitive is `packages/ui/src/components/primitives/bar-chart.tsx` with
  `styles/charts.css` and the `--chart-*` tokens.

## Adding a chart

Write the counting rule once, as owner SQL or an owner function, and use it for both the
chart and its records. Add the chart to `insightChartSchema`, the read model, the web
`definitions` with wording people can check against the records, and the reconciliation
test in `apps/api/e2e/insights.e2e.mjs`. State what the chart can't claim in its `limit`.

## Validation

- `pnpm --filter @luma/read-models test insights.test.ts` for coverage and placement rules.
- `pnpm test:e2e insights.e2e.mjs` checks every point against its records and the Orders
  list, linked orders, source filters, imported history, validation and tenant isolation.
- `pnpm --filter @luma/web test insights` for wording and URL state; the `UI/Bar chart`
  stories cover keyboard and pointer selection in both themes and on narrow screens.
- `pnpm test:browser insights.browser.mjs` covers the authenticated journey.

## Performance

Order charts filter `orders_list` on the btree-indexed `placed_at` range; fulfillment charts
read `orders_fulfillment_list` with the Fulfillment workspace rules. Set
`LUMA_INSIGHTS_BENCHMARK` to an order count when running `insights.e2e.mjs`; it spreads the
orders over 13 weeks and writes the fastest of three API requests to
`/tmp/luma107-insights-<count>.json`. Measured on the disposable PostgreSQL 17 test server on
2026-10-01 with 50,000 orders: 13-week order chart 48 ms, 30-day chart 31 ms, one record page
13 ms. Stock risk and purchase-order stages are classified in server memory by their owners,
like the operational summary, so they share its scale limits. Each read has a four-second
statement timeout.
