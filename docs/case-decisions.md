# Case decisions and progress

The case desk lets people review a case's immutable proposal, approve, reject, escalate or close
it, and follow execution and verification. A decision response is a durable receipt, not
an execution result, and a successful connector execution is never shown as a verified
resolution. `@luma/resolution` owns the desk; the API contract exposes it under each case.

## Reads

Reads require an active session and organization membership. Missing cases, foreign cases
and inaccessible organizations return the same 404. GET requests read persisted state only;
they never evaluate models or connector preconditions.

- **Review** returns the current proposal, policy result, approval and the decisions the
  caller may make (`permittedDecisions`).
- **Progress** returns persisted execution and canonical resolution, plus the live workflow
  phase when Temporal answers. Workflow queries have bounded deadlines; an unavailable
  Temporal service reports `unavailable` while persisted state stays readable.
- **Timeline** pages audit events from domain outboxes, policy, execution and decisions:
  25 by default, at most 100. Cursors bind tenant, case, page size and sort version.
  Events sort by timestamp at database precision, then ID; outbox and audit copies share
  one immutable event ID. Late events can land before a cursor, so refresh from the first
  page and deduplicate by ID. Entries carry bounded provenance, actors and outcomes, never
  proposal parameters or raw provider payloads. Actors are named as in
  [Activity](workspace-activity.md#attribution); review and progress keep user IDs and list
  the people they reference in `people`.

## Decisions

Escalation and manual closure need `issues.manage` (**Work on issues**). Approval and rejection need `decisions.respond` and an
approver who is not the proposal's requester. On submission the server checks membership,
role, current case and diagnosis revisions, the immutable proposal ID and version, policy
decision and version, expiry and current capability preconditions again. Unknown or
unavailable capabilities cannot be approved.

Clients copy `caseRevision`, `diagnosisRevision`, `proposalId`, `proposalVersion` and
`decisionId` from review, generate one UUID `commandId` per user decision and supply a
reason of 1–1000 characters. Escalation needs only the case and diagnosis revisions. Extra
body fields are rejected.

After a network timeout, read the receipt by command ID or retry the identical body and
command ID; exact retries return the original receipt. Reusing an ID with a different body
or actor returns 409, as do conflicting, stale and already answered decisions; refresh
review before deciding again. A rejection cannot become an approval through a retry.

Decision checks, approval and audit writes and the receipt share one transaction.
Escalation changes the canonical exception through its owning service and leaves it
unresolved. Execution reservation takes the same tenant lock and checks the case/proposal
binding, so a committed escalation, rejected proposal or changed diagnosis prevents a
later reservation. Once dispatch is reserved, escalation returns 409; it is not
cancellation or compensation. The workflow's 30-second approval poll observes committed
responses even without a wake-up notification.

## Manual closure

The `close` decision uses the same revision checks, command ID and receipt recovery as
other decisions. A reason of 1–1000 characters is required; evidence references are
optional, limited to 100, and must exist in the tenant. The exception owner records a
`human_disposition` with actor, reason, evidence and an audit event in the receipt
transaction. Manual closure never becomes verified resolution or verified success.

Closing is available for every unresolved state, including failed and escalated cases.
It removes the case from active attention. Pending proposals cannot be approved, renewed
or dispatched after closure. Case workflow admission observes the resolved case and stops
new work. Closure shares the case renewal and tenant dispatch locks, but does not cancel
or undo a write already reserved or sent. Running workflows may complete their current
work and checks; uncertain executions retain their reconciliation path. The client asks
for confirmation when work is active or workflow availability is unknown.

A resolved case stays immutable. Fresh evidence of the same fingerprint can create a
successor linked to the closed case; replaying old evidence does not reopen it.

## Proposals and workflow composition

Trusted proposal producers publish through the desk, which validates the execution action
schema, requester, current diagnosis and evidence references. Published actions are
immutable; a changed action needs a new investigation or proposal binding. No public
endpoint accepts arbitrary executable actions.

The desk's capability predicate describes installed action kinds and versions without
provider I/O; commands additionally resolve the actual adapter and check its
preconditions. A capability the installed effect registry does not resolve never becomes
an enabled action, even if persisted data names it. Manual recommendations stay separate
diagnosis data.

Passing the desk to the exception workflow runtime makes it persist the producer's action
before returning its reference and record the case/workflow association, for both
incident- and detection-started runs. The default worker uses already published proposals
and returns manual intervention when none is supported.

## Live updates

The case event stream is authenticated SSE. It emits a `resync` event immediately and every
five seconds, carrying a typed progress snapshot and `refetch: true`. Clients refetch case
detail, review, progress and timeline on every event and reconnect. `Last-Event-ID` yields
a fresh snapshot, not replay; durable history comes from the timeline.

Streams re-authenticate the original session before each snapshot and close on session
expiry, membership loss, tenant change or read failure. They rotate after one minute. At
most three concurrent streams per tenant and user and 100 per API process are allowed;
excess requests get 429. Slow consumers are disconnected rather than buffered, and
shutdown closes all streams. The shared client's subscription helper validates events and
reconnects; close it when the organization or case changes or the page unmounts.

## Case detail client rules

- Show canonical state beside workflow activity, execution outcome and independent
  verification. A passed check does not imply canonical resolution, and human disposition
  is labeled separately.
- The case header, investigation and resolution review share one case observation. Case
  and diagnosis revisions must agree before refreshed findings replace displayed ones or
  decisions become available; mismatched reads wait for the next refresh. Routine
  refreshes keep decision drafts and the recorded evidence freshness.
- Stream events refresh detail, review, progress and loaded history from the first page,
  reusing in-flight refreshes and deduplicating timeline entries by ID. History and
  evidence load in batches of 100.
- When the stream is interrupted but reads succeed, the case stays available, is labeled
  as interrupted, and polls every five seconds until live updates resume. Browser offline
  pauses decisions and receipt recovery and marks retained findings as unconfirmed. An
  unrelated inbox error does not change case freshness.
- A failed history read has its own retry and never blocks a current review. Access-denied
  responses hide the selected case. Navigation closes the old stream and isolates caches
  by organization and case.
- Failed and escalated cases show the available decisions and point to the current
  investigation without exposing retries.
