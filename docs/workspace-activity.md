# Workspace Activity

`/app/$organizationId/activity` lists workspace actions newest recorded first. Expand an event for attribution, timestamps, the proposed capability and resource, dispatch result, verification and evidence references. Open the original issue to review its evidence. Activity has no decision or retry commands.

## Filters and browsing

Search is a case-insensitive literal substring over issue ID, persisted target reference, action label and actor ID. It does not search raw payloads or free-form audit details. Filter by UTC recorded dates, system, connection UUID, event type and outcome. Dates cover at most 366 days; the initial view covers 30 UTC calendar days. Edit both endpoints, then select Apply dates. Invalid draft ranges leave the current results intact.

Filters, cursor, expanded event and the latest-seen event ID are validated URL state. Back navigation restores the page and expansion; the router restores scroll position. Each page contains 30 events. The API permits 1–100. A separate first-page read checks for new records every 30 seconds without inserting rows into the page being read. Refresh on older pages checks the head; Retry also reloads a failed historical page; Latest events returns to the first page. Offline and failed reads retain visible history with an explicit stale notice. Access errors hide private events.

## API and ordering

`GET /v1/organizations/:organizationId/activity` requires `from` and `to` ISO timestamps and accepts `q`, `system`, `connectionId`, `type`, `outcome`, `limit` and `cursor`. Date bounds are inclusive/exclusive. Results order by recorded timestamp descending, then immutable event ID descending. Occurrence time is separate: delayed records appear at the head when recorded. Cursors bind the tenant, current role, dates, filters and page size. Changed filters or role invalidate a cursor with HTTP 400.

The read surface uses tenant/date indexes and a security-invoker PostgreSQL view over existing append-only audit/outbox and command records. Every join includes the tenant. Durable policy and execution outbox events take precedence over audit delivery copies, preserving their first recording time and event ID. No per-row issue fetches or streams run. Evidence arrays, associated connections and displayed strings have explicit size bounds. Issue-level events resolve connections from persisted proposals, source evidence and connection subjects, so system/connection filters also find resolutions and escalations. Raw documents, credentials, grants and unrestricted audit details never enter the response.

## Outcomes and historical coverage

Approval is a decision, not execution. Dispatch without verification is not a verified resolution. Passed verification, failed verification, uncertain results and manual disposition remain distinct. A negative reconciliation read does not override an unknown execution state. Expansion includes execution state, verification phase and safe failure codes. Proposal/attempt references associate related events while each immutable record remains independently expandable. Playbook provenance identifies pilot records; absent execution-mode provenance is reported as unrecorded.

Coverage includes existing policy decisions, approvals, rejections, escalation, execution attempts, completion/reconciliation, individual execution and issue verification attempts, execution failures and human/verified issue resolution events. Pending and completed verification records retain separate immutable event IDs. Unaccepted issue verification stays uncertain even when its observed result passed. Owners and admins also see recorded connection lifecycle events. Membership is revalidated on every request. Nonmembers cannot read tenant history.

Playbooks currently persist activation reviews and current artifact revocation state, not a complete immutable activation/revocation event history. Activity does not invent timestamps or actors for those state changes. Older unrecorded changes and absent settings/access event producers remain unavailable. A source read failure fails the page instead of silently omitting that source.

## Verification

Migration `0020_activity_verification_history.sql` extends the original read view without changing an applied migration. Both the standard API and pilot runtime compose the Activity service.

`pnpm test:e2e activity.e2e.mjs` covers real PostgreSQL reads, permissions, URL contract bounds, cursor binding, equal timestamps, late arrivals, audit/outbox deduplication, real verification producer shapes, source-only connection association and outcome distinctions. The pilot suite also checks Activity through its actual HTTP composition. `pnpm test:browser activity.browser.mjs` covers filters, expanded evidence, detail/back, reload, historical date editing, pagination, refresh, offline recovery, failed historical-page retries, narrow keyboard use and workspace isolation. Storybook documents loading, empty, unavailable, stale, offline and access-loss states.
