# Workspace Activity

Activity lists recorded workspace actions, newest recorded first, with attribution,
timestamps, the proposed capability and resource, dispatch result, verification and evidence
references. It is read-only: it has no decision or retry commands. Both the standard API and
the pilot runtime compose the Activity service.

Code: `@luma/resolution` (activity read), `activity` API contract.

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
action label, actor ID and workflow run ID. It does not search raw payloads or free-form audit
details.

## Sources and safety

The read uses a security-invoker PostgreSQL view over existing append-only audit/outbox and
command records, with tenant/date indexes; every join includes the tenant. Durable policy and
execution outbox events take precedence over their audit delivery copies, preserving the first
recording time and event ID. No per-row issue fetches or streams run, and evidence arrays,
associated connections and displayed strings have explicit size bounds.

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
