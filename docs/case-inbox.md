# Case inbox

The case inbox lists persisted exception cases and their current investigation. Its reads
are tenant-scoped, read-only and cheap: they never run investigations, call models or
contact providers, and the canonical exception and diagnosis tables are the only source
of case data. Decisions, execution progress, audit history and live updates are covered
in [case decisions and progress](case-decisions.md).

## Attention and views

- **Needs you** contains persisted approval state, uncertainty escalation and current,
  rule-produced manual recommendations. Severity and model hypotheses never create
  attention. The workspace [Needs you queue](needs-you.md) shows the same case attention
  next to workflow and app decisions.
- **Active** includes failed and escalated cases.
- **History** includes verified resolutions and human dispositions, labeled separately.

An empty attention queue never implies healthy operations. Coverage reports only whether
any observations exist, not whether they are complete or healthy; connection availability
is read separately from the connection API.

Unknown impact stays unknown. Expired or resolved investigations hide their old
recommendations. A selected case stays open when it leaves the current filter. View,
filter and pagination state lives in validated search parameters.

## Lists and pagination

Lists filter by view, class, severity, state and responsible person (including unassigned), with 25 items per page by default and at
most 100. Keyset order is severity descending, attention time (or detection time)
ascending, then ID. List items omit diagnosis evidence. Cursors bind the tenant, filters
and page size. Cases move between pages as their state changes, so refresh restarts from
the first page and clients deduplicate by ID.

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
