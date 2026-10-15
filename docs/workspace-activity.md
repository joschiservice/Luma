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
Grouping precedes pagination, so a group is not repeated on older pages.

## Reads and ordering

Reading requires `activity.read` and membership is revalidated on every request. `from` and
`to` are required, inclusive/exclusive, and span at most 366 days. Pages default to 30 events
(1–100).

Results order by recorded timestamp descending, then immutable event ID descending.
Occurrence time is separate: delayed records appear at the head when they are recorded.
Cursors bind the tenant, whether the reader has restricted access, dates, filters and page
size; a change returns 400. Clients check for new records with a separate first-page read, so
new rows never shift the page being read.

Search is a case-insensitive literal substring over issue ID, persisted target reference,
action label, actor ID, the actor's name and current email, workflow name and workflow run ID.
It does not search raw payloads or free-form audit details.

`actor` keeps events recorded by any of up to 20 actors: user IDs, `luma` (actor kinds Luma
and Luma support), `workflow` (events with a workflow) and `me`. The service resolves `me` to the
reader before the store reads, so one shared view names each reader's own events. The filter
compares against the attribution the row shows, so a person also matches workflow runs that act
for them, and service identifiers are never people. It only narrows rows the visibility rules
already admitted: restricted events still need `activity.read_restricted`.

## Saved views

The Activity page keeps its filters as view conditions on `activityCatalog`, so they can be
saved, shared and remembered; search text, the page cursor and the open event stay in the URL
only. The API takes one value per filter except actors, so a condition with several values, a
repeated field or "match any" of several conditions needs repair rather than a broader read.
Recorded-time presets are stored as `within_last` and resolved to calendar days in the
workspace time zone on each read; custom ranges are stored as `between` days. Saved Activity
views have no metrics, charts, actions or export, because the view engine has no Activity
reader.

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
Raw documents, credentials, grants and unrestricted audit details never enter the response.

A source read failure fails the page instead of silently omitting that source.

## Outcomes

- Approval is a decision, not execution. Dispatch without verification is not a verified
  resolution.
- Passed verification, failed verification, uncertain results and manual disposition remain
  distinct. A negative reconciliation read does not override an unknown execution state.
- Unaccepted issue verification stays uncertain even when its observed result passed.
  Pending and completed verification records keep separate immutable event IDs.
- Proposal and attempt references associate related events; each immutable record remains
  independently expandable. Playbook provenance identifies pilot records; absent
  execution-mode provenance is reported as unrecorded.

## Coverage

Activity covers policy decisions, approvals, rejections, escalation, execution attempts,
completion and reconciliation, individual execution and issue verification attempts,
execution failures and human or verified issue resolution.

People with `activity.read_restricted` also see connection lifecycle events and access changes
(`type: 'access'`): member, invitation, role, approval-policy and app-permission changes,
summarized without emails, permission lists or tokens.

Playbooks persist activation reviews and current revocation state, not an immutable
activation/revocation history. Activity does not invent timestamps or actors for those
changes, and older unrecorded changes remain unavailable.
