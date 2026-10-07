# Verified outcomes and human involvement

Resolution owns schema v1 measurement facts and business rules. The shared v2
registry composes its public reader into the existing authorized PostgreSQL
repeatable-read query. No aggregate store or analytics service is added.

## Counting and time

The counting unit is one persisted incident ID, across every resolution run and
execution attempt. The window is the incident's first detection in
`[asOf - 24h|7d, asOf)`, defaulting to seven days. Late verification updates that
incident in its original detection cohort; it never creates another outcome or
moves it into a completion-time cohort. Once it ages out, choose the appropriate
reporting window; this API is deliberately limited to 24 hours and seven days.

Resolved incidents are immutable in the existing lifecycle. A repeated problem
creates a new incident linked through `previousExceptionId`, with its own first
detection cohort. The earlier verification remains retained evidence. The new
incident contributes pending work and recurrence. An unresolved incident never
counts as verified merely because an old resolution field or accepted execution
exists. Retries, duplicate deliveries and multiple approvals do not add units.
Recurrence counts linked incidents, not repeat observations within an active case.

A verified outcome requires current resolved state and an authoritative, complete,
passed independent incident verification with evidence and a nonfuture timestamp.
Time to outcome includes every attempt, from first detection to that verification.
The median uses all verified incidents; unresolved age is the maximum age among
incidents without verification, including human dispositions. Empty duration
cohorts return null. Failed execution alone never proves an incorrect action;
incorrect-action assessments require a proposal bound to the incident and owned
evidence. The incorrect-action metric counts incidents with such assessments,
not execution attempts.

`asOf` freezes cohort boundaries and ages; `readAt` is the actual snapshot read.
This is a current-state query, not historical time travel. Every page hashes the
full authorized cohort before transport pagination. Current changes, including
late assessments and verification, reject stale pagination with 409. Data-through
remains null: no complete provider scan or attribution watermark is inferred from
a latest observation. Complete coverage means complete classification of recorded
incidents within scope, never complete provider coverage.

## Facts and attribution

Owners/admins append facts with `POST /v1/organizations/:organizationId/exceptions/:exceptionId/measurements`:

- **Environment:** immutable live, partner pilot, synthetic, shadow or unknown.
  Unclassified historical incidents remain unknown. Known synthetic source markers and simulated installation targets
  override a live assessment. Detection inputs resolve through their retained
  evidence mappings; input IDs are not assumed to be source evidence IDs. A missing environment is excluded from live metrics,
  reported explicitly, and inspectable by choosing the unknown environment cohort.
  Classify from trusted deployment/source evidence; deployment mode alone does not
  establish whether provider data is live. Historical rows are not backfilled as live.
- **Eligibility:** eligible, ineligible or unknown, with rule version, reason and
  owned evidence. A later revision replaces its classification while retaining
  earlier assessments. This records reporting eligibility, grants no execution
  authority, and does not replace Action Admission or policy decisions.
- **Attribution:** none, approval, manual repair, operator correction or unknown,
  with a coverage interval, completeness and owned evidence. Absence requires a
  complete audit covering first detection through the current verification. A
  partial or expired interval leaves attribution unknown. A newer unknown assessment
  revokes a prior absence claim. Known human work is retained monotonically.
- **Incorrect action:** bound proposal identity, reason and evidence. No automated
  classifier upgrades a failed action into an incorrect action.
- **Partner baseline:** measured duration in seconds, nonzero sample count, partner
  reference, process version, sample interval and evidence. Recording rejects future
  coverage and durations longer than the sample interval. These are measured
  assessments, not model estimates. This release makes no time-saved or monetary
  value claim; later claims must reference retained comparable partner samples.

Approvals (including rejections), case decisions, operator run selections,
manual repair/intervention/edit and operator-investigation learning records and historical human dispositions are read directly from their
immutable authoritative owners across all runs. Their evidence identities appear
in the cohort. No absence assertion can clear them. Merely using a user principal
for a worker or having a manually authored workflow does not establish human work.
Known incorrect actions exclude a verified incident from the autonomous numerator.

A fully autonomous outcome requires known eligibility, independent verification,
complete absence-of-human-work attribution and no recorded incorrect action. The
rate denominator is **all eligible incidents in the detection cohort**, including
pending ones. Overview withholds its exact count/rate when relevant eligibility,
attribution or environment is unknown. The shared metric exposes the known count,
null total and unknown count instead. A classified ineligible-only cohort has a
known zero denominator and no percentage; no classified population is unavailable.

`GET .../exceptions/:exceptionId/measurements?after=0` returns up to 100 facts and
the current revision. Follow `nextRevision`. Facts retain trusted actor, recording
time, schema version, incident identity and sequence. Event and incident locks
serialize recording. `expectedRevision` rejects concurrent lost updates; identical
ID/request/actor replays return the original event without revalidating changed
sources. Conflicting identity or payload returns 409. All supplied references
must resolve to retained evidence owned by this tenant and incident. Members can
read; writes require a freshly refreshed context with `issues.manage`. Foreign and missing
incident/evidence IDs both return 404.

## Shared registry, delivery and bounds

The `resolution.*` family registers eligible, unknown eligibility, verified,
autonomous, human involvement, unknown attribution, pending, recurrence, incorrect
actions, median time to outcome and oldest pending outcome. Its only filters are
`environment` and `window`; mixing unsupported family filters returns 400. Defaults
are live/seven days. Every known count equals its full matching cohort length.
`unknownCount` is unresolved classification, while the unknown-specific metrics
count their known unknown cohorts. Breakdown figures describe the same population;
unknown environment describes the excluded detection population.

Queries use a three-second statement timeout and fail above 10,000 detected
incidents rather than truncating totals. Pages contain at most 100 items and offsets
stop at 10,000. Transport includes at most 50 evidence/fact identities per incident
and their full counts; the ledger and issue detail provide the remainder. A ledger
permits at most 1,000 immutable facts. These are workload bounds, not measured
latency guarantees.

Migration `0046_resolution_measurement.sql` grants RLS-scoped reads, append-only
owner writes and indexes. It adds committed notification triggers to measurement,
learning, admission binding, incident inputs/evidence/source and disposition-outbox rows.
Existing exception, policy approval and case-command triggers cover state and human
changes. The existing tenant SSE subscription invalidates the shared query; rollback
produces no change notification. Reconnect and periodic reconciliation recover
missed wake-ups. No incremental client counters are maintained.

Home shows the live measurement summary and links to Insights. The focused outcome
section provides environment/window controls, definition/cohort dialogs, evidence
ledgers and pagination. Live, synthetic, pilot and shadow are never combined.
Offline, unavailable and access-loss states hide previous counts; keyboard dismissal
restores focus. The broader performance Insights work remains separate (LUMA-65).

Validation: `measurement.test.ts`, `resolution-measurement.e2e.mjs` and
`resolution-measurement.browser.mjs`, plus the existing overview, shared registry
and notification suites.
