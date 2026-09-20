# Case inbox

The authenticated inbox at `/app/:organizationId/exceptions` opens cases at
`/app/:organizationId/exceptions/:exceptionId`. Desktop keeps the list beside the
investigation. Narrow screens show one pane; Back to inbox restores list focus
and scroll. Views, filters and pagination live in validated search parameters.
Refresh restarts pagination. Focus refetches persisted reads without moving focus.

Needs you includes persisted approval state, uncertainty escalation and current,
rule-produced manual recommendations. Severity and model hypotheses never create
attention. Active includes failed and escalated cases. History includes verified
resolutions and human dispositions; these are labeled separately.

The investigation presents impact, manual next steps, facts, hypotheses,
constraints and expandable provenance. Unknown impact stays unknown. Expired or
resolved investigations hide their old recommendations. No decision or connector
write controls are exposed. A selected case stays open when it leaves its filter.

## Read API

- `GET /v1/organizations/:organizationId/exceptions` accepts `view`, `class`,
  `severity`, `state`, `cursor` and `limit` (25 by default, at most 100).
- `GET /v1/organizations/:organizationId/exceptions/:exceptionId` returns the
  current persisted diagnosis with at most 100 evidence references, including
  observations that preceded diagnosis completion.
- `GET /v1/organizations/:organizationId/exceptions/:exceptionId/evidence`
  returns historical observation and verification references. It accepts `cursor`
  and `limit` (25 by default, at most 100), ordered by immutable evidence ID.
  Cursors bind the tenant, case, page size and sort version. Each page authenticates
  membership and checks case ownership. Unknown or inaccessible cases return 404.
  Refresh from the first page and deduplicate by ID as new observations arrive.

Evidence pages expose source identity, adapter/schema versions, observation time,
source update time and completeness. A null source update time means unknown.
Completeness is `complete` or `incomplete` only when the observation explicitly
records a boolean `complete` fact; otherwise it is `unknown`. It does not describe
connection coverage. Arbitrary provider facts and payloads are not returned.
Evidence can precede the current diagnosis or establish its verified resolution;
reading it does not start an investigation. Shared clients use
`client.exceptions.evidence({ params: { organizationId, exceptionId }, query })`.

Reads reuse identity guards and PostgreSQL RLS. They do not run investigations or
call models. List responses omit diagnosis evidence. Keyset pagination orders
severity descending, attention time (or detection time) ascending, then ID.
Cursors bind the tenant, filters and page size. Moving cases can cross page
boundaries; refresh starts from the first page and clients deduplicate by ID.

Coverage reports whether any observations exist, not whether they are complete or
healthy. Connection availability is read independently through the existing
connection API. An empty attention queue never implies healthy operations.

Case detail reads display at most 100 evidence references. Oversized investigations
explicitly report the omitted count and withhold findings, impact and recommendations;
pending investigations remain pending. Evidence pagination preserves access to the
complete persisted references. Proposal review, decisions, execution and audit reads,
and authenticated SSE are described in [case decisions and progress](case-decisions.md).
The inbox UI's decision controls and live timeline remain separate frontend work.
The canonical exception
and diagnosis tables remain the only source of case data.

## Database access

Migration `0006_case_reads.sql` adds `luma_case_reader`, a SELECT-only group with
tenant-scoped policies. Grant it to the API runtime login after migration:

```sql
GRANT luma_case_reader TO luma_api;
```

Managed local setup includes this grant. The API uses `IDENTITY_DATABASE_URL` for
case reads. Migration `0010_case_evidence_reads.sql` adds SELECT access and tenant
policies for evidence links and normalized inputs. The worker retains its separate
write permissions.

## Validation

UI stories cover the four classes, unknown classes, pending and failed diagnosis,
missing authority, stale observations, manual-only stock correction and verified
resolution. The synthetic inventory example compares 12 Shopify units with 4 JTL
units using an explicit mapping and JTL authority.

Database tests cover persisted reads, attention semantics, stable cursor ties,
filter/tenant cursor isolation and denied case reads. Browser acceptance covers
real authentication and persistence, empty coverage, pagination, direct links,
reloads, mobile selection, keyboard focus restoration, refreshed diagnosis,
filter departure, unavailable cases and API failure.

Evidence API tests cover more than 100 historical references, stable ordering,
current-diagnosis independence, verification evidence, cursor validation and
isolation, denied reads, restricted database privileges and typed client responses.
