# Case inbox

The case inbox lists persisted exception cases and their current investigation. Its reads
are tenant-scoped, read-only and cheap: they never run investigations, call models or
contact providers, and the canonical exception and diagnosis tables are the only source
of case data. Decisions, execution progress, audit history and live updates are covered
in [case decisions and progress](case-decisions.md).

## Attention and views

- **Needs attention** contains persisted approval state, uncertainty escalation and current,
  rule-produced manual recommendations. Severity and model hypotheses never create
  attention. The workspace [Needs you queue](needs-you.md) shows the same case attention
  next to workflow and app decisions.
- **All open** is the default and includes every unresolved case, including failed and escalated cases. Main navigation opens it regardless of the remembered view; explicit saved-view links and the return from an issue preserve their context.
- **History** includes verified resolutions and human dispositions, labeled separately.

An empty attention queue never implies healthy operations. Coverage reports only whether
any observations exist, not whether they are complete or healthy; connection availability
is read separately from the connection API.

Unknown impact stays unknown. Expired or resolved investigations hide their old
recommendations. A selected case stays open when it leaves the current filter.

## Lists and pagination

The issue list is a configurable list (see [shared list model](frontend-ui.md)): views keep
their conditions, sort, grouping, layout and properties, while search text stays in page state
because it can match record IDs. The list API takes conditions on the issues catalog fields:
class, state, severity, record type, owner (`me` resolves to each reader, empty is
unassigned), source system, attention reason, freshness, investigation status, resolution and
the detected, last-activity and waiting-since dates. The older `ownerId`, `class`,
`severity` and `state` parameters still work, and the web turns old links that use them into
conditions.

Filtered values are computed by the same rules the list presents, at the read time:

- Freshness is `fresh` only while the investigation's validity has not ended, `stale` after it
  and `unknown` without one. Stale and unknown evidence never match `fresh`.
- The investigation status reads `insufficient_evidence` once the evidence is stale or exceeds
  the display limit, as the detail does.
- Sources are the provider systems the shown evidence names. An issue with several sources
  belongs to each source's group.

Conditions, search and sorting are bound parameters over the attention projection; the view
counts (Needs you, active) are unchanged by them. Search matches the summary the API returns,
in English, and the record ID and type.

The default order is urgency: severity descending, attention time (or detection time)
ascending, then ID. Detected, last activity and waiting since sort either way; issues that wait
on nobody come last for waiting since in both directions. Groups (class, owner, severity, state
and source) return exact counts and their first rows, at most 50 groups. The board groups by
state and is read-only: state changes only through verification and dispositions.

Pages hold 25 items by default and at most 100. List items omit diagnosis evidence. Cursors
bind the tenant, reader, conditions, search, sort and page size; within a group they bind the
group key instead of the size. Cases move between pages as their state changes, so refresh
restarts from the first page and clients deduplicate by ID.

## Case detail and evidence

Case detail returns the current persisted diagnosis with at most 100 evidence references,
including observations that preceded diagnosis completion. A larger investigation reports
the omitted count and withholds findings, impact and recommendations; a pending
investigation stays pending.

The evidence endpoint pages through all historical observation and verification
references (25 by default, at most 100), ordered by immutable evidence ID. Cursors bind
tenant, case, page size and sort version. Every page re-authenticates membership and
checks case ownership; unknown and inaccessible cases both return 404. Refresh from the
first page and deduplicate by ID as observations arrive. Reading evidence never starts an
investigation.

Evidence exposes source identity, adapter and schema versions, observation time, source
update time and completeness, never arbitrary provider facts or payloads. A null source
update time means unknown. Completeness is `complete` or `incomplete` only when the
observation explicitly recorded a boolean `complete` fact; otherwise it is `unknown`. It
never describes connection coverage.

## Access

Reads reuse identity guards and PostgreSQL RLS through the API login's SELECT-only case
reader role (see [database roles](development.md#database-roles)). The worker keeps its
separate write permissions.

## Responsibility

Case owners can be assigned, reassigned or cleared by someone with `decisions.assign`.
The chosen person must be an active workspace member. Writes carry the current ownership
revision and append audit history atomically; stale revisions return 409. Ownership appears
in case detail, lists and Needs you. It grants no approval or execution permission. A case
workflow that hands a case nobody owns to people gives it to the person whose access it runs
with, through the same audited assignment (see [case workflows](workflows.md#case-workflows)).
