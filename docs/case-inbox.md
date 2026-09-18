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

Reads reuse identity guards and PostgreSQL RLS. They do not run investigations or
call models. List responses omit diagnosis evidence. Keyset pagination orders
severity descending, attention time (or detection time) ascending, then ID.
Cursors bind the tenant, filters and page size. Moving cases can cross page
boundaries; refresh starts from the first page and clients deduplicate by ID.

Coverage reports whether any observations exist, not whether they are complete or
healthy. Connection availability is read independently through the existing
connection API. An empty attention queue never implies healthy operations.

This implements the read slice needed from LUMA-32. Decision commands, executable
proposal projections, paginated historical evidence and streaming history remain
in their owning follow-up slices. The current diagnosis bounds its evidence at
100 references; the inbox displays that complete current set. The canonical
exception and diagnosis tables remain the only source of case data.

## Database access

Migration `0006_case_reads.sql` adds `luma_case_reader`, a SELECT-only group with
tenant-scoped policies. Grant it to the API runtime login after migration:

```sql
GRANT luma_case_reader TO luma_api;
```

Managed local setup includes this grant. The API uses `IDENTITY_DATABASE_URL` for
case reads. The worker retains its separate write permissions.

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
