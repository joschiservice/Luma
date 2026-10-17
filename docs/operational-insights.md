# Operational insights charts

Insights charts show orders, fulfillment backlog, stock risk, issues and purchase orders over
a calendar window or as current state. Every point opens the records it counts. A chart and
its record list are computed by the same rules, so their totals agree when they are read at
the same evaluation time.

Code: `@luma/read-models` (charts), with counting rules from the owning domains.

## Charts and rules

| Chart         | Unit                 | Kind      | Placement and series                                                                                                                                             |
| ------------- | -------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders`      | canonical order      | timeline  | Source `placed_at` in the bucket; series is the current status. Without a source filter the selected `orders_list` row counts, so linked orders count once.      |
| `fulfillment` | selected fulfillment | breakdown | Open work from the [Fulfillment workspace](fulfillment-workspace.md) rules, by hours since progress; series is the first of held, overdue, stalled, else `none`. |
| `stock`       | stock position       | breakdown | Procurement's stock classification: unknown stock, below minimum with or without a draft/open purchase order, or at/above minimum.                               |
| `cases`       | issue                | timeline  | First detection from Exceptions; series is the issue class. Reopened issues keep their first detection.                                                          |
| `procurement` | purchase order       | breakdown | Stage from Procurement's commitment summaries, excluding closed and cancelled; series is whether a confirmation or delivery is overdue.                          |

Timelines never reconstruct past states: statuses are current, and breakdowns describe only
the evaluation time. Resolution performance stays in
[resolution measurement](resolution-measurement.md).

When the tenant's resolution-reporting release is enabled, Insights uses the same metric
registry and attribution ledger for explicit reporting intervals, recurrence tables,
verification durations and recorded workflow versions. These reporting cohorts remain
separate from the commerce charts; their rules and release boundaries are documented in
[resolution measurement](resolution-measurement.md#resolution-reporting).

Buckets are calendar days or Monday-based weeks in the requested IANA time zone, computed in
PostgreSQL. The last bucket ends at the start of the next local day. The orders chart
reconciles with the Orders list: a point's `start`/`end` days are the list's
`placedFrom`/`placedTo`, and its series is the list's `status`.

Without a source filter, fulfillment uses one source view per linked order and work kind: Starshipit shipments, otherwise Shopify, then another source. Split shipments from that view remain separate. Source-filtered reads retain that source’s own records. Shipping-only order views do not contribute to commercial order totals.

## Views and links

The page shows timelines under Trends, breakdowns under Now beside the
[operational metrics](operational-metrics.md), and resolution measurement under Outcomes.
`view` is optional in the address: without it, an open chart selects the view that contains
it, a range selects Trends, and report or outcome filters select Outcomes, so links created
before views existed still open their records. Navigation writes `view` only when the rest of
the address wouldn't select it; otherwise closing an inferred view's records would switch views.

Each view puts only the metrics it shows into the page's live summary; connection health reads
the operational part on every view. The toolbar's live status and Refresh describe the view on
screen, so Outcomes reports the resolution read, including a denied resolution part. The
resolution report's rolling period ends when Outcomes is opened or refreshed, not on every live
refresh, so live updates recount one fixed cohort.

## Coverage and data-through time

Commerce charts list each in-scope connection with its sync stream state: `complete`,
`limited` (history starts after the window starts), `importing`, `stale` (no complete read for
24 hours), `failing`, `paused`, `disconnected` or `not_synced` (records arrive only as
observations). `dataThrough` is the oldest stream watermark; it is null when any source never
completed a read. A timeline point lying wholly before every source's history start is
`not_imported`, which the UI draws as unknown, never as zero. A point that starts before some
history or ends after `dataThrough` is `partial`.

Issue and purchase-order charts read Luma's own records: their coverage is complete and their
data-through time is the evaluation time. Stock coverage is unavailable without active rules
and partial while any monitored position has unusable stock.

## Previous period

Timelines return `previous`: the same rules and filters counted from one range length before
the window's start until one range length before `asOf`, in local time. Comparing up to `asOf`
rather than the whole previous period keeps a partly elapsed day or week fair. Order coverage
uses the same point rules as the timeline. Issues exist only from Luma's first recorded
detection, so a previous stretch before it is `not_imported` or `partial`: before that, an empty
period can't be told from one Luma wasn't watching. The organization's creation time isn't
used; runtime roles can't read it and seeded or imported history may predate it. The web app
shows a change only when the previous stretch, the overall coverage and every finished bucket
are complete.

Records accept `point=previous`, which matches the stretch the chart's `asOf` defines, so the
list totals `previous.total` with the same rules and filters. The Orders list filters whole
days and can't express a stretch that ends at a time of day, so the record panel offers no
Orders link for it.

The orders chart returns 503 while an existing tenant's order-list projection awaits
[backfill](orders-workspace.md#backfill-and-rollout). Only the rebuild command clears this;
repeating the chart request does not advance it.

## Records and access

Record pages hold at most 100 rows. Records require an `asOf` no older than 15 minutes, so a
chart's time-based rules (stall window, overdue) classify records the same way the chart did.
Any workspace member can read charts; tenant row security scopes every query.

## Live refresh

Charts share the [workspace change stream](operational-metrics.md#live-delivery) and refresh
for the orders, issues, inventory, procurement, workflows and connections topics. Live
invalidations read at most once per two seconds and let active reads finish before processing further
changes. After a failed read, stream events cannot start another attempt for 30 seconds;
explicit refresh, filter changes, focus and reconnect still request current data. Failed
charts hide earlier values.

## Limits

Order charts filter `orders_list` on its indexed `placed_at` range, and fulfillment charts read
`orders_fulfillment_list`; both stayed under 50 ms at 50,000 orders. Stock risk and
purchase-order stages are classified in server memory by their owners, like the
[operational metrics](operational-metrics.md#limits), so they share those scale limits. Each
read has a 4-second statement timeout. Re-measure with `LUMA_INSIGHTS_BENCHMARK=<order count>`
on `insights.e2e.mjs`.

## Adding a chart

Follow the [add-insights-chart](../.agents/skills/add-insights-chart/SKILL.md) skill. Write the
counting rule once and use it for both the chart and its records, and state what the chart
can't claim in its `limit`.
