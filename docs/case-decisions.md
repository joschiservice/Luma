# Case decisions and progress

Every route below is under `/v1/organizations/:organizationId/exceptions/:exceptionId`.
Reads require an active session and organization membership. Missing cases,
foreign cases and inaccessible organizations return the same 404 response.

| Route                       | Behavior                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `GET /review`               | Current immutable proposal, policy result, approval and permitted decisions.           |
| `POST /decisions`           | Approve, reject or escalate using current versions and a unique command ID.            |
| `GET /decisions/:commandId` | Recover the submitting actor's committed receipt after a timeout.                      |
| `GET /progress`             | Persisted execution and canonical resolution, plus live workflow phase when available. |
| `GET /timeline`             | Paginated audit events from domain outboxes, policy, execution and decisions.          |
| `GET /events`               | Authenticated SSE with current progress and a request to refetch authoritative reads.  |

Use the shared client's `caseDesk` methods. `subscribeToCaseProgress` from
`@luma/api-contract/client` opens a credentialed EventSource, validates event data,
reconnects automatically and returns a cleanup function. Close it when changing
organizations or cases and when leaving the page.

## Decisions and recovery

Escalating needs `issues.manage`; approval and rejection need `decisions.respond` and an approver different
from the proposal requester. Review returns `permittedDecisions`; the server checks
membership, role, current case and diagnosis revisions, immutable proposal ID and
version, policy decision/version, expiry and current capability preconditions again
on submission. Unknown or unavailable capabilities cannot be approved. GET requests
read persisted state and do not evaluate models or connector preconditions.

Copy `caseRevision`, `diagnosisRevision`, `proposalId`, `proposalVersion` and
`decisionId` from review. Generate one UUID `commandId` for the user's decision.
Supply a reason of 1–1000 characters. Escalation needs the case and diagnosis
revisions but no proposal or policy ID. Extra body fields are rejected.

A successful response is a durable decision receipt, not an execution result.
After a network timeout, retrieve `/decisions/:commandId` or retry the identical
body and command ID. Exact retries return the original receipt. Reusing an ID with
a different body or actor returns 409. Conflicting, stale and already answered
decisions also return 409; refresh review before making another decision.
A rejected response cannot become an approval through a retry.

Decision checks, approval/audit writes and receipt persistence share one database
transaction. Escalation changes the canonical exception through its owning service
and leaves it unresolved. Execution reservation uses the same tenant lock and
checks the case/proposal binding. A committed escalation, rejected proposal or
changed diagnosis prevents a later reservation. Once dispatch has been reserved,
operator escalation returns a conflict; it is not cancellation or compensation.
The workflow's durable 30-second approval poll observes committed responses even
when no wake-up notification is delivered.

## Proposals and workflow composition

Migration `0011_case_decisions.sql` adds immutable proposal and workflow bindings,
append-only command receipts, scoped permissions and the dispatch fence. Grant
`luma_desk` to the API and worker logins; managed setup already does so. It inherits
case-reader, policy and audit access. Apply migrations before starting the new API.

`createDeskServices(db, identity, effectRegistry, options)` composes the boundary.
The trusted `capability` predicate describes installed supported action kinds and
versions without provider I/O. Commands additionally resolve the actual adapter
and check its preconditions. The default production registry has no write adapters,
so proposals never become enabled actions merely because an unfamiliar capability
appears in persisted data. Connection lifecycle remains in the connector module.

Trusted proposal producers use `desk.publish(context, exceptionId,
diagnosisRevision, action)`. Publication validates the existing execution action
schema, requester, current diagnosis and evidence references. A changed action
requires a new investigation/proposal binding; callers cannot overwrite an action.
There is no public endpoint accepting arbitrary executable actions.

Pass `desk` as the final argument to `createExceptionWorkflowRuntime` when composing
a proposal producer. It persists the producer's immutable action before returning
its reference and records the case/workflow source association. The default worker
uses already published proposals. It still returns manual intervention when no
supported proposal exists. Manual recommendations remain separate diagnosis data.

The API connects to Temporal lazily when workflow settings are supplied. Both
incident and detection source bindings are supported. Workflow queries have bounded
deadlines. An unavailable Temporal service is reported as `unavailable`, while
persisted execution and case resolution remain readable. A successful connector
execution is never represented as verified case resolution.

## Streaming and audit pagination

SSE emits a `resync` event immediately and every five seconds. Its JSON data contains
`schemaVersion`, `exceptionId`, `refetch: true` and a typed `progress` snapshot.
Refetch case detail, review, progress and timeline on every event and reconnect.
`Last-Event-ID` triggers a fresh snapshot, not historical event replay. Use timeline
reads for durable history and deduplicate entries by ID.

Streams reauthenticate the original session before each snapshot and close on
session expiry, membership loss, tenant changes or read failure. They rotate after
one minute. Limits are three concurrent streams per tenant/user and 100 per API
process; excess requests receive 429. Slow consumers are disconnected rather than
buffered indefinitely. Shutdown closes all streams.

Timeline pages default to 25 and allow up to 100 events. Cursors bind tenant, case,
page size and sort version. Events sort by timestamp, preserving database precision,
then ID. Outbox/audit copies share one immutable event ID. Late events may fall
before a cursor, so refresh from the first page and deduplicate as live state changes.
Responses include bounded provenance, actors and outcomes, not raw provider payloads.

The operations overview continues to use its explicit windows, denominators and
observation-coverage contract. Persisted pending approvals feed the shared attention
projection, including the inbox and overview; empty attention never proves health.

## Live case detail

Case detail shows canonical state alongside workflow activity, execution outcome
and independent verification. A passed check does not imply canonical resolution;
human disposition is labeled separately. Expand attempts, action criteria, audit
events and historical evidence to inspect actors, timestamps and provenance.
The timeline omits proposal parameters and raw provider payloads. Resolution
review presents the proposed action and permitted approval, rejection or
escalation decisions.

The authenticated stream refreshes detail, review, progress and loaded history
from the first page. Reads with conflicting case or diagnosis revisions are
rejected until the next refresh. Timeline entries are deduplicated by immutable ID.
History and evidence load in batches of 100; Load more reads another batch while
retaining the current case and expanded evidence. Repeated stream events reuse
in-flight refreshes. Routine refreshes preserve recorded evidence freshness;
connection uncertainty is shown separately.
Connection loss marks displayed records as last confirmed, and automatic reconnect
resynchronizes them. Refresh progress also restarts the stream. Navigation closes
the old stream and isolates caches by organization and case; reload reconstructs
state from persisted reads. Failed and escalated cases show available decision
names and direct operators to the current investigation without exposing retries.

### Shared case observation

The selected case header, investigation and resolution review share a case observation.
Case and diagnosis revisions must agree before refreshed findings replace the displayed
ones or decisions become available. Routine refreshes preserve decision drafts.

Browser offline events pause decisions and mark retained findings as unconfirmed.
When the live stream is interrupted but authenticated reads still succeed, the case
remains available and shows “Live updates interrupted.” Reads poll every five seconds
until live updates resume. An unrelated inbox error does not change case freshness.

History loads separately. A failed history read shows its own retry action without
blocking a current review. Loaded records remain visible as previously loaded history;
access-denied responses hide the selected case. Receipt recovery retains the original
command identity and is paused while offline.
