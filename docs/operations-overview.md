# Operations overview

The authenticated workspace overview reads
`GET /v1/organizations/:organizationId/operations/overview?window=24h|7d`.
The default window is 24 hours. The server returns its exact UTC start, end and
snapshot time. Verified resolutions use `[start, end)`; active cases, attention
and connection health describe the current state, including older unresolved cases.

Counts and the five priority decisions use the inbox's persisted attention rules.
Severity descending, oldest attention request, then ID determine the order.
Decisions link to case details in the `needs_you` view. Reads never run diagnosis
or a model. Connection and case projections remain in their owning modules;
the workflow application service composes their public readers.

Connection freshness uses the newest persisted commerce observation for each
requested and granted read capability. All must fall within the last 24 hours;
future observations do not count. Missing capability observations are unobserved,
even if another capability has recent data. Installation or credential update
times never establish freshness. A recent observation does not prove complete
source coverage. The UI distinguishes onboarding, missing observations, stale
data, inactive connections, active work, explicit attention and healthy observed
operations. Intentionally disconnected installations remain visible as history but
do not affect monitored health. Revoked, degraded and pending connections still
require attention. When all connections are retired, health remains unknown.
Failures hide previous health claims and totals until retry succeeds. Offline
queries show a paused notice and hide health and totals, including before the
first load. Reconnection resumes the query automatically.

Automation eligibility and human-work attribution are not persisted yet. Both
`automaticallyResolved` and `automation` therefore return null. The UI displays
“Unavailable”; verified resolutions remain a separate count and are never
relabelled as automatic. The contract supports an authoritative numerator and
denominator when those records become available. A zero denominator displays no
percentage. Synthetic automation values exist only in Storybook.

TanStack Query isolates caches by organization and window, discards unused private
data, polls every 30 seconds while visible, and refreshes on focus or reconnect.
The window is shareable URL state. Requests use cancellation and no-store caching.
The summary fails as a whole if either required reader fails.

Migration `0009_overview_reads.sql` grants the case-reader role tenant-scoped,
read-only access to connection documents and observations. It does not grant
access to encrypted credentials. Existing identity guards protect the endpoint.

Validation covers summary windows, tenant isolation, bounded priority ordering,
per-capability freshness, future timestamps, credential denial, response validation,
Storybook accessibility and keyboard interactions, and connected browser navigation,
retry and mobile layout.

The order operations section uses the [shared metric registry](operational-metrics.md)
for open, overdue and attention orders. Its observed counts and drill-down records
share a consistent database snapshot. Incomplete coverage remains visible; missing
deadlines and complete totals are never replaced with fabricated zeros.
