# Operations overview

The operations overview tells Home what needs attention, what Luma is handling and how
healthy each connection is. Reads never run diagnosis or a model, and connection and case
projections stay in their owning modules; the workflow application service composes their
public readers. The summary fails as a whole if either required reader fails.

## Windows

`window` is `24h` (default) or `7d`. The server returns its exact UTC start, end and snapshot
time. Verified resolutions use `[start, end)` by completion time. Active cases, attention and
connection health describe the current state, including older unresolved cases.

The nested `measurement` summary comes from the versioned
[resolution measurement](resolution-measurement.md) reader and uses live incidents first
detected in the window, a different cohort from `verifiedResolutions`. Exact
`automaticallyResolved` and `automation` are available only with complete classification;
unknown facts and unclassified environments remain visible, and a known zero denominator
displays no percentage. No verified outcome is relabelled automatic without complete
human-work attribution.

## Attention

Counts and the five priority decisions use the inbox's persisted attention rules, ordered by
severity descending, oldest attention request, then ID. Home's attention module and its
headline count read the [Needs you queue](needs-you.md) instead, which adds replenishment,
supplier and app decisions to these case decisions.

## Connection health

Freshness uses the newest persisted commerce observation for each requested and granted read
capability. All must fall within the last 24 hours; future observations do not count. A
capability without observations is unobserved, even if another capability has recent data.
Installation or credential update times never establish freshness, and a recent observation
does not prove complete source coverage.

Intentionally disconnected installations remain visible as history but do not affect
monitored health. Revoked, degraded and pending connections still require attention. When all
connections are retired, health is unknown. The case-reader role reads connection documents
and observations, never encrypted credentials.

## Client behavior

Caches are isolated by organization and window. The client polls every 30 seconds while
visible and refreshes on focus or reconnect, with cancellation and no-store caching. Failures
and offline states hide previous health claims and totals, including before the first load,
until a read succeeds.

The order operations section on Insights uses the [shared metric registry](operational-metrics.md)
and follows committed changes through the live metric stream.
