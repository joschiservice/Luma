# ADR-003: Tenant isolation and regional data residency

Status: proposed for review. Decision: 2026-09-17, LUMA-6.

## Context and decision

V0 runs one modular backend and one shared PostgreSQL database in the EU. An organization is a tenant: `organizations.id` is the canonical UUID used as `tenant_id`. Choose explicit tenant context, scoped repositories, composite constraints and PostgreSQL row-level security (RLS). Query filters alone leave accidental omissions unprotected; a database per tenant adds provisioning and migration work before enterprise demand exists.

This ADR defines required schema/API conventions for LUMA-7/8 and subsequent adapters. The current backend exposes only `/health`; no database, authentication or tenant resource exists yet. These are implementation requirements, not a claim that isolation is already deployed. Ownership follows [ADR-001](001-module-boundaries.md); this decision refines [ADR-002](002-canonical-commerce-model.md).

## Organization and placement

| Field / concept             | V0 convention                                                                    | Future path                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `organizations.id`          | Application-generated UUID; sole tenant identity                                 | Preserved across placement changes                                                                      |
| `organizations.data_region` | Required `text DEFAULT 'EU' CHECK (data_region IN ('EU', 'US', 'APAC'))`         | Same logical values; each enabled region maps to approved physical locations                            |
| Provisioning                | Missing region defaults to EU; explicit US/APAC requests fail as unavailable     | Enable only after the complete regional cell passes residency checks                                    |
| Placement                   | Server-owned configuration resolves EU to the single EU cell and shared database | Identity owns a private directory mapping tenant to region, cell, database target and placement version |

`data_region` is not a client preference or a nearest-server hint. Resolve it from identity after authorization; never infer it from IP, locale, browser timezone or request headers. The organization row is the authority for its logical region. V0 has no per-row region copies, cell tables or global routing service. Provisioning must validate enabled regions before creating a tenant, even though the schema reserves US/APAC. An existing unsupported or inconsistent placement fails closed; it never falls back to EU.

Keep organization placement immutable through ordinary application APIs and database grants. A future change requires an audited migration, not `PATCH dataRegion`. Country/provider selection remains a hosting decision: “APAC” alone does not name an acceptable jurisdiction. Every cell must explicitly list its approved physical locations and services before activation.

## Trusted context and API conventions

Identity resolves a context containing `tenantId`, `dataRegion`, `actor` and `requestId`; placement resolution adds a trusted cell/database target internally when needed. Actor uses ADR-002's user/service/agent/connector identity and initiating-user provenance. Context is required, immutable for one operation, and passed explicitly to use cases and repositories; do not use optional tenant arguments, process globals or caller-supplied context objects.

1. Tenant HTTP routes use `/v1/organizations/:organizationId/<resource>`. The path selects an organization; it does not authorize access. Validate the session, resolve its user, verify current membership and organization state, then load placement and build context. LUMA-8 owns this guard. Deny business operations for suspended/closed tenants; narrowly authorized identity, export and retention operations have separate use cases.
2. All resource reads, lists, counts, searches, exports, writes and bulk actions require this context. A lookup is `(context.tenantId, resourceId)`, never `resourceId` alone. Reject tenant/region fields in ordinary mutation bodies; assign `tenant_id` from context on inserts. Check nested/JSON references through tenant-scoped owner interfaces.
3. LUMA-7 contracts use camelCase `organizationId`/`dataRegion` externally and reserve `EU | US | APAC`. Provisioning alone accepts an optional region, returning `422 REGION_UNAVAILABLE` for a reserved but inactive value. Public health checks remain tenant-free and reveal no tenant data.
4. Return `401` for missing/invalid authentication, `404` for an inaccessible organization or a missing/foreign resource, and `403` for insufficient capability within an authorized organization. Normalize constraint errors so they do not expose another tenant's records. Wrong-cell execution returns `503 REGION_UNAVAILABLE` before tenant data access; trusted routing can resolve the correct cell before dispatch, never silently process in the receiving cell.
5. Webhooks derive tenant and connection from a verified signature/credential and server-owned installation mapping. Jobs use authenticated internal envelopes; a tenant ID in a message is insufficient. Resolve tenant status, placement and service authority at execution/resume time and recheck policy before external effects. Cross-tenant batch work fans out into separately authorized tenant operations.

Representative application port (contract notation, not a new shared package):

```ts
getOrder(context: TenantContext, query: { orderId: string }): Promise<OrderDto | null>;
```

Identity owns context semantics. Platform exposes a technical transaction adapter accepting the resolved tenant UUID without importing identity. Audit uses its explicit tenant-bearing evidence envelope. Honor ADR-001's dependency graph; do not add identity imports to audit or platform just to share a type. Application and domain modules never receive an unrestricted database client.

## Database isolation contract

Every tenant-owned table requires `tenant_id uuid NOT NULL`, `UNIQUE (tenant_id, id)`, tenant-leading lookup indexes and ADR-002's composite same-owner foreign keys. Shared identity tables are exceptions described below. Updates cannot transfer ownership. Scope business uniqueness, idempotency and deduplication by tenant; cross-owner UUIDs remain validated through public owner interfaces.

Migrations must enable and force RLS on tenant-owned tables in the same migration that creates them. Runtime roles are non-owner, non-superuser and `NOBYPASSRLS`, with only necessary DML grants; no schema changes, `TRUNCATE`, role escalation or policy modification. Migration/backup credentials remain separate from API and worker processes. Audit grants remain append-only.

Representative policy for an existing `orders` table and runtime role:

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_access ON orders TO luma_runtime
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Missing/empty context matches no rows and rejects writes; malformed UUID context errors. Apply the same tenant gate to every runtime role that can access the table. Review any additional policy so it cannot widen tenant access. RLS does not replace membership or capability checks. PostgreSQL documents its role bypasses, policy behavior and constraint exceptions in [row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

The platform transaction adapter must validate the resolved UUID, start a transaction, and call parameterized `SELECT set_config('app.tenant_id', $1, true)` on that transaction's connection before any repository SQL. All queries use that handle and still include explicit tenant predicates. Commit/rollback releases the handle; never use session-level tenant settings or the pool directly inside the callback. The `true` flag scopes the setting to the transaction; see [configuration functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET) and [SET LOCAL lifetime](https://www.postgresql.org/docs/current/sql-set.html). Retries start a fresh transaction and install context again. No remote I/O occurs inside this transaction.

RLS protects against an omitted SQL filter, not a compromised backend that can set arbitrary context. Prevent SQL injection with bound parameters and keep context construction behind identity authorization. Composite constraints prevent foreign-tenant references independently of policy evaluation.

### Identity bootstrap and privileged operations

`organizations` is the tenant root and has no redundant `tenant_id`; its normal tenant policy compares `id` to the transaction tenant. Memberships and invitations are tenant-owned and use `tenant_id` (map Better Auth's organization reference one-to-one). Users, credential accounts, sessions and verification records are identity-owned, region-local authentication data and may span memberships within that cell; they are not commerce tables and do not receive a fabricated tenant ID.

Authentication must work before a tenant is selected. LUMA-8 provides a separate, narrowly privileged identity adapter for session validation, listing the authenticated user's memberships, resolving organization placement and atomic organization/first-owner creation. Its credentials/grants cannot access commerce tables; never use the migration role or a blanket RLS bypass. Membership/organization bootstrap policies must be explicitly scoped to the verified user or provisioning operation and tested with the chosen Better Auth adapter. No general-purpose unscoped identity query is exported to other modules.

Support, retention and backfills use explicit per-tenant context and audit actor/reason. Exceptional administrative repair and full backups use separate controlled operational credentials, never a public “all tenants” flag. Before US/APAC activation, define regional login/federation: do not replicate users, credentials or sessions globally by default. V0 supports multiple organizations in its one EU identity store.

## Regional data boundary

A cell is a complete regional data plane: API/worker compute, database, storage, workflow runtime and configured external processing endpoints. V0 deploys one EU cell; no active-active writes, global tenant-data replication or automatic cross-region failover.

| Data or service            | Required boundary                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL and auth        | Tenant rows, identity data, replicas, snapshots, backups and restores stay in the assigned region; validate backup settings separately from primary location.                                                                                                                                                                                    |
| Objects and secrets        | Raw payloads, exports, attachments, recordings and keys/secret stores stay local. Authorize `(tenant, object)` before issuing short-lived access; prefixes alone are not authorization.                                                                                                                                                          |
| Workflow and queues        | Journals, inputs/results, outbox, retries, dead letters and scheduled jobs stay local. Envelope and dedupe keys include tenant identity; a worker rejects a different region before loading payloads.                                                                                                                                            |
| Browser execution          | Browser compute, profiles, cookies, credentials, screenshots, downloads and recordings stay local. Allocate isolated tenant/connection sessions; never reuse profiles across tenants. A regional recording bucket alone is insufficient.                                                                                                         |
| Observability              | Sentry errors, Langfuse traces/prompts, PostHog events and application logs containing tenant/user data use approved regional ingestion, processing and retention. Scrub credentials and payloads; disable session replay and automatic sensitive capture by default.                                                                            |
| Model routing              | Tenant prompts, retrieved context, tool arguments/results, embeddings and provider logs use an approved regional processing endpoint and retention configuration. Region is a routing constraint, including retries and fallback models. If unavailable, stop/escalate; never fall back globally.                                                |
| Cache, search and frontend | Server caches, indexes and temporary files stay local and are keyed by tenant. Authenticated SSR/server functions execute in-cell; tenant responses are private/no-store and excluded from global CDN caches. Client query caches are tenant-keyed and cleared on logout or organization change. Global delivery may serve public static assets. |

Verify the full service path, including subprocessors and support access, before enabling tenant data on a provider. No provider is declared compliant merely because it offers an EU endpoint. The Bedrock EU route for tenant authoring prompts is reviewed in [the model processing-path review](003-model-processing-path-review.md). Customer-authorized Shopify/JTL operations and delivery to the user's browser are explicit external destinations; this ADR constrains Luma-managed persistence and processing and does not promise those destinations are EU-hosted. Minimize transferred data and record connector/model policy decisions.

Future global control-plane metadata is limited to opaque tenant ID, region, cell ID, placement version and routing status; no names, emails, credentials, payloads or telemetry. Treat even this directory as restricted metadata with authenticated access. It is not needed for V0. Tenant-bound requests and bodies must reach their cell without being terminated or logged in another region.

## Dedicated enterprise placement and moves

Keep the same tenant UUID, schemas, API contracts and RLS when moving an enterprise tenant to its own database in the same region. Resolve its server-owned database target through placement and inject the matching pool; never accept a database URL from a caller. Dedicated credentials, backup/restore and migration tracking belong to that placement. A database alone does not isolate objects, browser profiles, queues or telemetry: a stronger isolation agreement may require an entire dedicated cell.

Future placement changes require a separate runbook: suspend new work, drain/fence workers, migrate and verify all tenant state, atomically publish the new placement version, invalidate caches/sessions/credentials as needed, then resume. Reject stale job placement versions. Define rollback before cutover and delete/expire source copies and backups under the agreed retention policy. A cross-region move additionally requires explicit customer approval and migration of every boundary above; updating one row is insufficient. No move machinery is built in V0.

## Implementation acceptance and follow-ups

These checks are required before serving tenant resources; documentation review does not replace them:

| Owner                             | Required verification                                                                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LUMA-7/8                          | Two tenants with similar resource identifiers: unauthenticated, nonmember, forged tenant/body/region, foreign nested references, list/count/export and insufficient-role requests disclose no foreign data. Valid member access works; suspended/closed tenants cannot run business operations. |
| First database migrations         | Real PostgreSQL under runtime roles: missing context denies access; omitted query filters still isolate; cross-tenant insert/update/FKs fail; pooled A → B requests, rollback and retries cannot retain A's context. Verify every tenant table's RLS, policy and role grants.                   |
| Identity implementation           | Bootstrap can authenticate, list only the user's memberships and create the first owner atomically; its role cannot read commerce data. Revoked membership/session cannot build usable context.                                                                                                 |
| Worker/storage/browser adapters   | Forged tenant envelopes, foreign object keys, shared browser profiles, stale placement and revoked authority fail before data access/effects; legitimate retries remain tenant-idempotent.                                                                                                      |
| Hosting/observability/model setup | EU defaults succeed; US/APAC provisioning and wrong-cell work fail. Inspect actual processing, backup and export locations. Unsupported regional browser/model/telemetry providers remain disabled; simulate fallback failure without cross-region egress.                                      |

LUMA-7 implements transport conventions; LUMA-8 implements identity/context guards and auth schema. Each table owner implements its RLS/constraints when adding persistence. Hosting and durable/browser provider decisions must meet the regional boundary before handling real tenant data. This task adds the architecture contract and aligns existing conventions without installing those systems.

## Consequences and reversal cost

Shared infrastructure keeps V0 small; explicit context plus RLS adds transaction discipline and real-database testing. EU-only operation trades cross-region availability for a clear residency boundary. Dedicated databases later require placement-aware pools and coordinated migrations, but preserve tenant IDs and contracts. Changing the tenant root, bypassing context or allowing unrestricted global processing would require a replacement ADR and data/access migration.

Source: [LUMA-6](https://linear.app/auren-labs/issue/LUMA-6/define-tenant-isolation-and-regional-data-residency-model). Related decisions: [ADR-001](001-module-boundaries.md), [ADR-002](002-canonical-commerce-model.md).
