# ADR-003: Tenant isolation and regional data residency

Status: accepted. Production activation remains subject to the operational and legal review below.

## Context and decision

The launch cell runs one modular backend and one shared PostgreSQL database in Australia. An organization is a tenant: `organizations.id` is the canonical UUID used as `tenant_id`. Choose explicit tenant context, scoped repositories, composite constraints and PostgreSQL row-level security (RLS). Query filters alone leave accidental omissions unprotected; a database per tenant adds provisioning and migration work before enterprise demand exists.

The application implements authenticated tenant context, regional placement and scoped persistence. No production cell is deployed; architecture and provider documentation do not establish actual processing or backup placement. Ownership follows [ADR-001](001-module-boundaries.md); this decision refines [ADR-002](002-canonical-commerce-model.md).

## Organization and placement

Each process serves one `LUMA_REGION`: `EU`, `AU` or `US`. New development environments
and production configuration default to AU; production enables AU alone. EU and US remain
available for synthetic development and boundary verification, but cannot accept production
workspaces before their complete service path is reviewed.

The organization UUID is the sole tenant identity. Its required `data_region` has no
database default and is immutable through runtime grants. The migration role provisions a
single immutable cell-region record; API, worker and staff API compare their configuration
with that record before serving work. Runtime roles can read it but cannot change it.
A custom PostgreSQL setting cannot replace this record because runtime sessions can set it.

Identity owns the placement directory. Tenant context resolves placement after membership
and account checks and rejects a different cell with `503 REGION_UNAVAILABLE` before
commerce data access. Provisioning supplies the cell region explicitly and accepts only
its enabled regions, returning `422 REGION_UNAVAILABLE` otherwise. Region never comes
from IP, locale, timezone or a client header. No regional migration or global directory is
implemented, and an existing EU development database must run as EU or be intentionally reset.

Public discovery and registration use `luma.ai`. Regional product hosts are
`au.app.luma.ai`, `eu.app.luma.ai` and `us.app.luma.ai`; API and staff hosts belong to the
same cell. Accounts and sessions remain cell-local. The passkey relying-party ID is
`luma.ai`, allowing separately registered cell-local accounts to use the same verified
parent domain without globally replicating credentials. Region choice occurs before
creating the account or workspace, and ordinary APIs cannot move either.

## Trusted context and API conventions

Identity resolves a context containing `tenantId`, `dataRegion`, `actor` and `requestId`; placement resolution adds a trusted cell/database target internally when needed. Actor uses ADR-002's user/service/agent/connector identity and initiating-user provenance. Context is required, immutable for one operation, and passed explicitly to use cases and repositories; do not use optional tenant arguments, process globals or caller-supplied context objects.

1. Tenant HTTP routes use `/v1/organizations/:organizationId/<resource>`. The path selects an organization; it does not authorize access. Validate the session, resolve its user, verify current membership and organization state, then load placement and build context. Identity owns this guard. Deny business operations for suspended/closed tenants; narrowly authorized identity, export and retention operations have separate use cases.
2. All resource reads, lists, counts, searches, exports, writes and bulk actions require this context. A lookup is `(context.tenantId, resourceId)`, never `resourceId` alone. Reject tenant/region fields in ordinary mutation bodies; assign `tenant_id` from context on inserts. Check nested/JSON references through tenant-scoped owner interfaces.
3. API contracts use camelCase `organizationId`/`dataRegion` externally and reserve `EU | AU | US`. Provisioning alone accepts an optional region, returning `422 REGION_UNAVAILABLE` for a reserved but inactive value. Public health checks remain tenant-free and reveal no tenant data.
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

Authentication must work before a tenant is selected. Identity provides a separate, narrowly privileged identity adapter for session validation, listing the authenticated user's memberships, resolving organization placement and atomic organization/first-owner creation. Its credentials/grants cannot access commerce tables; never use the migration role or a blanket RLS bypass. Membership/organization bootstrap policies must be explicitly scoped to the verified user or provisioning operation and tested with the chosen Better Auth adapter. No general-purpose unscoped identity query is exported to other modules.

Support, retention and backfills use explicit per-tenant context and audit actor/reason. Exceptional administrative repair and full backups use separate controlled operational credentials, never a public “all tenants” flag. Before another production cell is activated, define regional login/federation: do not replicate users, credentials or sessions globally by default. Each cell supports multiple organizations in its local identity store.

## Regional data boundary

A cell is a complete regional data plane: API/worker compute, database, storage, workflow runtime and configured external processing endpoints. The launch target is one AU cell; no active-active writes, global tenant-data replication or automatic cross-region failover.

| Data or service            | Required boundary                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL and auth        | Tenant rows, identity data, replicas, snapshots, backups and restores stay in the assigned region; validate backup settings separately from primary location.                                                                                                                                                                                    |
| Objects and secrets        | Raw payloads, exports, attachments, recordings and keys/secret stores stay local. Authorize `(tenant, object)` before issuing short-lived access; prefixes alone are not authorization.                                                                                                                                                          |
| Workflow and queues        | Journals, inputs/results, outbox, retries, dead letters and scheduled jobs stay local. Envelope and dedupe keys include tenant identity; a worker rejects a different region before loading payloads.                                                                                                                                            |
| Browser execution          | Browser compute, profiles, cookies, credentials, screenshots, downloads and recordings stay local. Allocate isolated tenant/connection sessions; never reuse profiles across tenants. A regional recording bucket alone is insufficient.                                                                                                         |
| Observability              | Sentry errors, Langfuse traces/prompts, PostHog events and application logs containing tenant/user data use approved regional ingestion, processing and retention. Scrub credentials and payloads; disable session replay and automatic sensitive capture by default.                                                                            |
| Model routing              | Tenant prompts, retrieved context, tool arguments/results, embeddings and provider logs use an approved regional processing endpoint and retention configuration. Region is a routing constraint, including retries and fallback models. If unavailable, stop/escalate; never fall back globally.                                                |
| Cache, search and frontend | Server caches, indexes and temporary files stay local and are keyed by tenant. Authenticated SSR/server functions execute in-cell; tenant responses are private/no-store and excluded from global CDN caches. Client query caches are tenant-keyed and cleared on logout or organization change. Global delivery may serve public static assets. |

Verify the full service path, including subprocessors and support access, before enabling tenant data on a provider. No provider is declared compliant merely because it offers an EU endpoint. The regional Bedrock route for tenant authoring prompts is reviewed in [the model processing-path review](003-model-processing-path-review.md). Customer-authorized Shopify/JTL operations and delivery to the user's browser are explicit external destinations; this ADR constrains Luma-managed persistence and processing and does not promise those destinations share the workspace region. Minimize transferred data and record connector/model policy decisions.

Future global control-plane metadata is limited to opaque tenant ID, region, cell ID, placement version and routing status; no names, emails, credentials, payloads or telemetry. Treat even this directory as restricted metadata with authenticated access. It is not needed for V0. Tenant-bound requests and bodies must reach their cell without being terminated or logged in another region.

## Dedicated enterprise placement and moves

Keep the same tenant UUID, schemas, API contracts and RLS when moving an enterprise tenant to its own database in the same region. Resolve its server-owned database target through placement and inject the matching pool; never accept a database URL from a caller. Dedicated credentials, backup/restore and migration tracking belong to that placement. A database alone does not isolate objects, browser profiles, queues or telemetry: a stronger isolation agreement may require an entire dedicated cell.

Future placement changes require a separate runbook: suspend new work, drain/fence workers, migrate and verify all tenant state, atomically publish the new placement version, invalidate caches/sessions/credentials as needed, then resume. Reject stale job placement versions. Define rollback before cutover and delete/expire source copies and backups under the agreed retention policy. A cross-region move additionally requires explicit customer approval and migration of every boundary above; updating one row is insufficient. No move machinery is built in V0.

## Regional service decisions and activation evidence

A regional endpoint is a configuration boundary, not proof of storage, backup, support
or TLS termination location. Startup rejects unapproved service origins. AU hosted
telemetry and mail have no implicit allowlist; operators must explicitly allow an
inspected endpoint or keep the service disabled. Provider offerings below were checked
against primary documentation. **Actual production processing, storage, backups, restores,
contracts and support paths remain uninspected because nothing is deployed.** The
platform operator must retain account-specific evidence before the first real customer.

| Service                                     | AU decision and provider evidence                                                                                                                                                                                                                                                                                                                                                                                         | EU / US policy                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| PostgreSQL, identity and compute            | Sydney RDS PostgreSQL and in-cell compute; [RDS offers Sydney and Melbourne](https://docs.aws.amazon.com/general/latest/gr/rds-service.html). Inspect engine/version, replicas, snapshots, automated backups and a restore. Melbourne may hold in-country disaster-recovery copies only.                                                                                                                                  | Same complete cell boundary; no shared account/session store.                                               |
| Objects, exports, secrets and backup copies | Sydney regional storage and secret stores. [S3 offers both Australian regions](https://docs.aws.amazon.com/general/latest/gr/s3.html). Inspect bucket locations, replication rules, backup vaults and restore targets; no default global copies.                                                                                                                                                                          | Approved in-jurisdiction storage and backups only.                                                          |
| Temporal                                    | Self-host in Sydney across availability zones with local persistence and backups. [Temporal Cloud offers Sydney](https://docs.temporal.io/evaluate/cloud/regions), but lists no same-region replication there; all offered Sydney cross-region replicas leave Australia. Cloud single-region could be reviewed separately; Cloud HA is disallowed for AU.                                                                 | Region-local persistence, queues and approved replication only.                                             |
| Temporal encryption keys                    | One single-region [AWS KMS Sydney key](https://docs.aws.amazon.com/general/latest/gr/kms.html); client-side AES-256-GCM envelope encryption is mandatory in production. Inspect IAM, key policies, rotation and history recovery; no cross-region key or decrypt fallback.                                                                                                                                                | One regional KMS key and explicit old-key read permissions per cell.                                        |
| Bedrock                                     | Sydney only for active requests. Australia profiles are usable only after destination and retention inspection; no APAC/global profile. See the [processing review](003-model-processing-path-review.md).                                                                                                                                                                                                                 | Regional models and reviewed in-jurisdiction profiles; unavailable routes stop.                             |
| Mail / Resend                               | Disable until a regional mail adapter is provisioned or an explicit overseas exception is legally approved. [Resend has no Australian sending region and stores account data in the US regardless of sending region](https://resend.com/docs/dashboard/domains/regions); [its US storage includes message content and logs](https://resend.com/security/gdpr).                                                            | A sending region alone proves no residency; any Resend use needs an explicit US subprocessor exception.     |
| Sentry                                      | Hosted exporter disabled; use inspected Sydney self-hosting if required. [Hosted Sentry exposes US and DE locations](https://docs.sentry.io/api/), not AU. Scrubbing does not make personal identifiers anonymous.                                                                                                                                                                                                        | Only approved regional ingestion, storage and operational support paths.                                    |
| PostHog                                     | Hosted exporter disabled; feature flags use an explicitly inspected Sydney instance. [Cloud offers EU/US; self-hosting is officially unsupported](https://posthog.com/docs/self-host), so the operator owns upgrades, recovery and security. Flags default off when unavailable.                                                                                                                                          | Approved regional instance; no cross-cell fallback or session replay.                                       |
| Langfuse                                    | Disable prompt tracing until an inspected Sydney self-hosted instance exists. [Cloud offers EU, US and Japan](https://langfuse.com/security/data-regions), with regional backup copies, not AU.                                                                                                                                                                                                                           | Approved regional deployment and backups; no foreign-region prompt tracing.                                 |
| Gmail Pub/Sub                               | Require topic message-storage policy containing only `australia-southeast1`; inspect existing topics, subscriptions and retention. [Google documents in-region storage/processing and `enforceInTransit`](https://docs.cloud.google.com/pubsub/docs/resource-location-restriction). Confirm Gmail publishing remains compatible before enabling push. Resource metadata is global and belongs in the subprocessor review. | Equivalent jurisdiction-specific topic policy; Gmail remains a customer-authorized external provider.       |
| Vercel AI Gateway                           | Disallowed for AU tenant data, including sensitive retries or fallback.                                                                                                                                                                                                                                                                                                                                                   | Sensitive routes require a reviewed regional processor; unrestricted routes never receive sensitive inputs. |
| Staff support                               | Japan-based staff require explicit AU region scope plus customer-approved, time-limited, audited support grants. Database location does not prevent overseas access.                                                                                                                                                                                                                                                      | Staff scopes are cell-specific; another region's grant cannot authorize access.                             |

## Residency promise and subprocessor review

The customer-facing promise below is a **draft, not a claim about a deployed service**:

> Workspace data, backups and AI processing are hosted in Australia. Account sign-in data
> and scrubbed operational telemetry may be processed by the subprocessors listed. Support
> staff in Japan may access workspace data under time-limited, audited support grants.

Publish it only after the actual selected services and legal review support every sentence.
Sign-in data is currently cell-local; do not add an overseas sign-in exception unless an
actual approved processor requires it. The AU subprocessor schedule must list AWS Australia
(compute, PostgreSQL, objects, secrets, backups, KMS and models), Google (customer-authorized
Gmail and Australian Pub/Sub message content, with global resource metadata), any selected
mail/telemetry operator and its actual countries, and the legal entity employing support
staff in Japan. Disabled Resend, Sentry Cloud, PostHog Cloud, Langfuse Cloud and Vercel AI
Gateway are excluded until separately approved and disclosed. EU/US schedules require
separate regional service and support reviews; those production cells are disabled.

Legal review must establish whether Japan-based support staff belong to the same legal
entity, a contractor or a related company. [OAIC distinguishes same-entity overseas use
from disclosure to a separate overseas entity](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-8-app-8-cross-border-disclosure-of-personal-information).
Do not assume Japan's APPI automatically satisfies APP 8.2(a); counsel must confirm the
applicable protections and enforcement. Japan's EU adequacy status matters only for a
future EU cell. When support moves to Australia, remove Japan-based support access and
update the published countries and contractual schedule.

## Consequences and reversal cost

Shared infrastructure keeps V0 small; explicit context plus RLS adds transaction discipline and real-database testing. Single-cell operation trades cross-region availability for a clear residency boundary. Dedicated databases later require placement-aware pools and coordinated migrations, but preserve tenant IDs and contracts. Changing the tenant root, bypassing context or allowing unrestricted global processing would require a replacement ADR and data/access migration.

Source: [LUMA-6](https://linear.app/auren-labs/issue/LUMA-6/define-tenant-isolation-and-regional-data-residency-model). Related decisions: [ADR-001](001-module-boundaries.md), [ADR-002](002-canonical-commerce-model.md).
