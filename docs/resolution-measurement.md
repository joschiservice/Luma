# Verified outcomes and human involvement

Resolution measurement reports how many incidents reached an independently verified
outcome, how many did so without human work, and what is still pending or unknown. It
counts persisted incidents only, never infers completeness it cannot prove, and withholds
a number rather than guessing. `@luma/resolution` owns the facts and rules; the `resolution.*`
metric family is read through the shared metric registry's authorized PostgreSQL
repeatable-read query. There is no aggregate store.

## Counting and time

- **Unit:** one persisted incident ID, across every resolution run and execution attempt.
  Retries, duplicate deliveries and multiple approvals add nothing.
- **Cohort:** incidents first detected in `[asOf - 24h|7d, asOf)`, seven days by default.
  Late verification updates the incident in its detection cohort; it never moves it to a
  completion-time cohort or creates another outcome. Resolution reporting also offers
  30-day and explicit half-open intervals, independently from the detection-cohort metrics.
- **Recurrence:** resolved incidents are immutable. A repeat creates a new incident linked
  by `previousExceptionId` with its own cohort; it adds pending work and recurrence, and the
  earlier verification stays retained. Recurrence counts linked incidents, not repeated
  observations within an active case.
- **Verified:** current resolved state plus an authoritative, complete, passed independent
  incident verification with evidence and a non-future timestamp. An old resolution field
  or an accepted execution never counts.
- **Durations:** time to outcome runs from first detection to that verification, across
  all attempts; the median uses every verified incident. Unresolved age is the maximum age
  of incidents without verification, including human dispositions. Empty cohorts return
  null.
- **Incorrect actions:** a failed execution alone never proves an incorrect action. The
  metric counts incidents with an assessment bound to a proposal for that incident and
  owned evidence, not execution attempts.

`asOf` freezes cohort boundaries and ages; `readAt` is when the snapshot was read. This is
a current-state query, not time travel. Each page hashes the full authorized cohort before
pagination, so any change, including late assessments or verification, rejects stale
pages with 409. Data-through stays null: no provider scan or attribution watermark is
inferred from the latest observation. Complete coverage means every recorded incident in
scope is classified, never complete provider coverage.

## Assessment facts

People with `issues.manage` append facts to an incident's measurement ledger:

- **Environment:** live, partner pilot, synthetic, shadow, observe-only or unknown; immutable. Classify
  from trusted deployment and source evidence; deployment mode alone does not establish
  that provider data is live. Known synthetic source markers and simulated installation
  targets override a live assessment. Detection inputs resolve through their retained
  evidence mappings; input IDs are not source evidence IDs. Unclassified incidents stay
  unknown, are excluded from live metrics and are inspectable through the unknown cohort.
  A persisted observe-only execution result classifies its incident as observe-only,
  even if someone assessed it as live or its sources are synthetic. This remains true
  after a mode change. It never contributes a verified or autonomous outcome, including
  when a later operator change produces an independent passing verification.
- **Eligibility:** eligible, ineligible or unknown, with rule version, reason and owned
  evidence. A later revision replaces the classification and keeps earlier assessments.
  This is reporting eligibility only; it grants no execution authority and does not
  replace admission or policy.
- **Attribution:** none, approval, manual repair, operator correction or unknown, with a
  coverage interval, completeness and owned evidence. Claiming no human work requires a
  complete audit from first detection through the current verification; a partial or
  expired interval leaves attribution unknown, and a newer unknown assessment revokes an
  earlier absence claim. Known human work is retained monotonically.
- **Incorrect action:** bound proposal identity, reason and evidence. No classifier
  upgrades a failed action into an incorrect one.
- **Partner baseline:** measured duration in seconds, nonzero sample count, partner
  reference, process version, sample interval and evidence. Future coverage and durations
  longer than the sample interval are rejected. Baselines are measurements, not model
  estimates; no time-saved or monetary claim is made, and any future claim must reference
  retained comparable partner samples.

Facts record trusted actor, recording time, schema version, incident identity and sequence.
Writes serialize on event and incident locks; `expectedRevision` rejects lost updates.
Identical ID, request and actor replays return the original event without revalidating
changed sources, and conflicting identity or payload returns 409. Every reference must
resolve to retained evidence of this tenant and incident; foreign and missing IDs both
return 404. Reads need `issues.read` and page 100 facts at a time by revision. Each page lists
the people who recorded its facts in `people`, named as in
[Activity](workspace-activity.md#attribution).

## Human work and autonomy

Human work is also read directly from its immutable owners across all runs: approvals
(including rejections), case decisions, operator run selections, manual repair,
intervention, edit and investigation learning records, and historical human dispositions.
Their evidence appears in the cohort, and no absence assertion can clear them. Running a
worker as a user principal or using a manually authored workflow does not count as human
work.

A **fully autonomous outcome** needs known eligibility, independent verification, complete
absence-of-human-work attribution and no recorded incorrect action. Its denominator is all
eligible incidents in the cohort, including pending ones. When relevant eligibility,
attribution or environment is unknown, the Overview withholds the exact count and rate,
while the shared metric exposes the known count, a null total and the unknown count. A
cohort classified as only ineligible has a known zero denominator and no percentage.

## Registry and bounds

The family covers eligible, unknown eligibility, verified, autonomous, human involvement,
unknown attribution, pending, recurrence, incorrect actions, median time to outcome and
oldest pending outcome. The default filters are `environment` and `window` (live, seven
days). Released resolution reporting adds first-detection volume, verification-period
volume and verification-period duration, plus exact start/end, issue-class, connection and
recorded workflow-version filters. Every known count equals its full cohort length.
`unknownCount` is unresolved classification, while the unknown-specific metrics count
known-unknown cohorts. Breakdowns describe the same population; unknown environment
describes the excluded population. Live, synthetic, pilot, shadow and observe-only are never combined.
Offline, unavailable and access-loss states hide previous counts.

Workload bounds, not latency guarantees: a three-second statement timeout; failure above
10,000 incidents in the union of detection and verification intervals rather than truncated
totals; reporting intervals of at most 366 days; pages of at most 100 with offsets
up to 10,000; at most 50 evidence or fact identities per incident in transport, with full
counts (the ledger and issue detail have the rest); at most 1,000 facts per ledger.

## Resolution reporting

`resolution-insights` is a tenant-scoped PostHog release that defaults off. It exposes the
reporting definitions and permits their queries through the existing metric registry.
It never changes measurement facts or their permissions. Workflow-version attribution and
filters additionally require `workflows.read`.

Detection volume and the eligible, autonomous, human-work and pending denominators use
first detection within `[start,end)`. Verification volume and its duration distribution
use authoritative, complete independent verification within that interval, including
incidents detected earlier. Unknown environment remains excluded and disclosed separately
for each counting basis; manual closure and failed verification never enter verification
volume. Current retained facts are evaluated at `asOf`; this is not historical time travel.

The UI renders interval bounds in the workspace timezone. Daily reporting buckets are
explicit UTC days. Duration bins are under five minutes, five minutes to under one hour,
one hour to under one day, and one day or longer. Fewer than five verified incidents carry
a small-sample label. Equal-duration prior-period comparisons require complete recorded
cohorts with at least five detections each and make no causal claim. Missing provider
watermarks remain null, rather than being inferred from the latest verification.

Class and connection breakdowns count unique incidents. A recorded workflow-version cohort
can overlap another across attempts; adding version rows does not produce total incidents.
Missing or retired connection labels retain the source identity. No version is inferred
when attribution was not recorded.

Reporting cursors bind the authorized actor, tenant, exact filters, metric set, page size,
evaluation time and complete incident cohort. Changed filters reject the cursor with 422;
late events or attribution changes reject a changed cohort with 409 so the reader refreshes.
Opening a report record retains its URL filters and interval for return navigation.

Committed changes to measurement, learning, admission binding, incident inputs, evidence
and sources, disposition outbox, exception, approval and case-command rows notify the
tenant's live stream, which invalidates the shared query; rollbacks notify nothing.
Reconnects and periodic reconciliation recover missed wake-ups. Clients keep no
incremental counters.
