# Workspace Activity

Activity groups recorded workspace actions into business events, newest recorded first, with attribution,
timestamps, the proposed capability and resource, dispatch result, verification and evidence
references. It is read-only: it has no decision or retry commands. Both the standard API and
the pilot runtime compose the Activity service.

Code: `@luma/resolution` (activity read), `activity` API contract.

The web and Home request the business view. It keeps one event per issue, workflow run or
proposal and expands up to 100 earlier steps that passed the same visibility and filters.
Routine step records and approval-rule checks cannot create a business event by themselves;
they remain in the event history. Approval, accepted writes, uncertain outcomes and verified
results keep their distinct labels. The API's event view retains individual immutable records.
Grouping precedes pagination, so a group is not repeated on older pages. Customer erasures are
`privacy` events whose summary is their counts only (profiles, messages, threads, replies,
rules); the audit entry holds no customer identifier to show.

## Reads and ordering

Reading requires `activity.read` and membership is revalidated on every request. `from` and
`to` are required, inclusive/exclusive, and span at most 366 days. Pages default to 30 events
(1–100).

Results order by recorded timestamp descending, then immutable event ID descending.
Occurrence time is separate: delayed records appear at the head when they are recorded.
Cursors bind the tenant, whether the reader has restricted access, dates, filters and page
size; a change returns 400. Clients check for new records with a separate first-page read, so
new rows never shift the page being read.

The Activity page appends older pages below the loaded ones and keeps no cursor in the URL. A
link to an event the loaded list doesn't hold reads that event's group alone with `event`,
under the same filters; an empty result means the filters or date range exclude it. New events
are offered, not inserted: the page polls the first page every 30 seconds and shows them only
when the reader asks, by reading every loaded page again.

A page reads back only as far as it takes to fill it: the newest 2,000 events, then wider
windows, then the whole date range. The result is the same as reading the whole range, because
a window reaching back from the end holds a group's newest meaningful event whenever it holds
any of them, and groups it doesn't reach sort after the page. A group's steps can be older than
the window, so they are read separately through the group's indexed links. Without filters only
a group's newest events can be its steps, so a large group costs no more than a small one; with
filters, every event of the page's groups is read, because older ones may be the matches.

Cost therefore grows with how far back the reader pages and how rare the filters' matches are.
Search and filters that match little, and opening a linked event, can still read the whole
range. A read past the statement timeout fails with a 503 that says to choose a shorter range.

Counts read the business groups each outcome would list, ignoring the outcome filter, so the
quick views can show how many events each holds. A group counts under every outcome one of its
non-routine events has, matching what the outcome filter lists. Counts cover the newest 10,000
events in the range. When the range holds more they are marked `truncated`, so each is a lower
bound that the quick views show as `N+`. The page reads counts only when the filters change, on
refresh and when the poll sees a new event.

Search is a case-insensitive literal substring over issue ID, issue class (with underscores
read as spaces), persisted target reference, action label, actor ID, the actor's name and
current email, workflow name and workflow run ID. Issue names are translated in the web, so the
client also sends `searchIssueClasses`, the classes whose names in the reader's language
contain the search text; events of those classes match too. Search does not cover raw payloads
or free-form audit details.

`outcome` keeps events with any of the named outcomes. The filter applies before grouping, so
a group appears under the outcome of its newest event that the filter admits. `actor` keeps
events recorded by any of up to 20 actors: user IDs, `luma` (actor kinds Luma
and Luma support), `workflow` (events with a workflow) and `me`. The service resolves `me` to the
reader before the store reads, so one shared view names each reader's own events. The filter
compares against the attribution the row shows, so a person also matches workflow runs that act
for them, and service identifiers are never people. It only narrows rows the visibility rules
already admitted: restricted events still need `activity.read_restricted`.

## Saved views

The Activity page keeps its filters as view conditions on `activityCatalog`, so they can be
saved, shared and remembered; search text, the page cursor and the open event stay in the URL
only. The API takes one value per filter except outcomes and actors, so a condition with
several values, a repeated field or "match any" of several conditions needs repair rather than
a broader read. The **Needs a look** and **Verified** quick views are outcome conditions
(escalated, failed and uncertain; verified), so they save and share like any other filter.
Recorded-time presets are stored as `within_last` and resolved to calendar days in the
workspace time zone on each read; custom ranges are stored as `between` days. Saved Activity
views have no metrics, charts or actions, because the view engine has no Activity reader.

## Export

Activity exports through its own endpoint rather than the view engine. It needs
`lists.export` as well as `activity.read`, refuses read-only support views, and writes every
event the filters match in the event view, one row per immutable record, up to 5,000 rows; a
longer result is cut off and says so. Visibility is the list's, so restricted events need
`activity.read_restricted`. The server writes recorded codes; the client sends headings and
names for the codes it knows in the reader's language, and codes without a name stay as
recorded. Each export appends a `collections.exported` audit entry for the `activity` domain
with its row count, whether it was cut off and how many filters applied, never its values.

## Attribution

Each event names its actor in the same page query, so cost does not grow with page size.
People resolve through `workspace_people`, the workspace's own record of current and former
members; Activity never reads the global users table, so a person who belongs only to another
workspace stays unnamed. Former members keep the name recorded when they left and lose their
email; a user ID with no recorded name reads as a former member rather than as an empty actor.
Detection and verification events without an actor, and the nil UUID, read as Luma. Access
changes made by Luma staff record the nil UUID with `actor_kind='staff'` and read as Luma support;
the staff identity stays in the staff audit. Services
and connectors keep their recorded identifier. Workflow runs act for the person who activated
them, so an event correlated with a run names both that person and the workflow.

## Sources and safety

The read uses a security-invoker PostgreSQL view over existing append-only audit/outbox and
command records, with tenant/date indexes; every join includes the tenant. Durable policy and
execution outbox events take precedence over their audit delivery copies, preserving the first
recording time and event ID. No per-row issue fetches or streams run, and evidence arrays,
associated connections and displayed strings have explicit size bounds.

Governed operations can bind an explicit order subject independently of their execution
target. Their decisions, dispatch and verification then appear on that order's activity
timeline. The subject is supplied by the trusted service from its reviewed mappings;
neither action parameters nor display numbers establish an activity association.

Issue-level events resolve connections from persisted proposals, source evidence and
connection subjects, so system and connection filters also find resolutions and escalations.
Evidence rows name evaluation inputs, not sources: the sources are the ones an input's
`facts.evidenceRefs` or the issue's resolution references. A read resolves all its issues
together, once. Row-level security keeps JSON expressions out of index conditions, so a lookup
keyed on a computed issue ID per event would scan the tenant's evidence for each one.
They also carry the issue's class from the already joined issue record, so a row can say what
it concerns without a per-row read. Record references that are storage IDs are not shown as
names. Raw documents, credentials, grants and unrestricted audit details never enter the
response.

A source read failure fails the page instead of silently omitting that source.

## Outcomes

- Approval is a decision, not execution. Dispatch without verification is not a verified
  resolution.
- Passed verification, failed verification, uncertain results and manual disposition remain
  distinct. A negative reconciliation read does not override an unknown execution state.
- Unaccepted issue verification stays uncertain even when its observed result passed.
  Pending and completed verification records keep separate immutable event IDs.
- Proposal and attempt references associate related events; each immutable record remains
  independently expandable. The page hides routine steps, rule checks that passed and checks
  that only started, until the reader shows them; a started check reads as waiting, not as an
  unclear result. Playbook provenance identifies pilot records; absent
  execution-mode provenance is reported as unrecorded.

## Coverage

Activity covers policy decisions, approvals, rejections, escalation, execution attempts,
completion and reconciliation, individual execution and issue verification attempts,
execution failures and human or verified issue resolution.

People with `activity.read_restricted` also see connection lifecycle events and access changes
(`type: 'access'`): member, invitation, role, approval-policy and app-permission changes,
summarized without emails, permission lists or tokens. Access changes also show Luma support's
work in the workspace: inspection requests (by Luma support), their approval, decline or
revocation (by the member who answered), lapses (by Luma) and emergency inspection with its
category, as well as support views and support access consent. Request reasons appear in
Settings › Luma support for approvers, not in Activity; emergency reasons and references and the
staff identity are never shown.

Playbooks persist activation reviews and current revocation state, not an immutable
activation/revocation history. Activity does not invent timestamps or actors for those
changes, and older unrecorded changes remain unavailable.
