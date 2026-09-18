# Authentication and organization access

Luma stores Better Auth users, credentials and sessions in its PostgreSQL database. Organizations are tenants; membership roles are `owner`, `admin` and `member`. V0 provisions only EU organizations.

## Local setup

For automatic setup, run `pnpm run setup` and `pnpm dev` as described in the
[development guide](development.md). The following steps are for an existing,
manually managed PostgreSQL instance.

Use Node 24 and PostgreSQL 17. Keep the database and all identity processing in the approved EU deployment for production. Docker is optional; an existing local PostgreSQL instance also works.

```sh
docker run --name luma-postgres \
  -e POSTGRES_PASSWORD=local_migration_password -e POSTGRES_DB=luma \
  -p 127.0.0.1:5432:5432 -d postgres:17-alpine
MIGRATION_DATABASE_URL=postgresql://postgres:local_migration_password@127.0.0.1:5432/luma \
  pnpm --filter @luma/api db:migrate
```

With an administrative connection, provision a separate runtime login:

```sql
CREATE ROLE luma_api LOGIN PASSWORD 'local_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT luma_identity,luma_case_reader TO luma_api;
```

Copy `apps/api/.env.example` to `apps/api/.env`. Set `IDENTITY_DATABASE_URL` to the restricted login, generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`, and set the public auth origin in `BETTER_AUTH_URL`. `AUTH_TRUSTED_ORIGINS` lists exact browser origins, including `http://localhost:3000` for Vite. Production origins require HTTPS. Never give the API migration credentials.

Run `pnpm dev:manual`. The web proxy forwards `/api/auth/*` to `/auth/*` and `/api/v1/*` to `/v1/*`. Production must provide the same-origin proxy and forward `Origin` and cookies. Better Auth uses `/auth` as its backend base path; callers using its browser client must configure the public `/api/auth` base path. `/ready` checks connectivity, migrated tables and runtime role restrictions.

Migrations run in one transaction under an advisory lock. The runner records checksums in `identity_migrations`, skips applied files and rejects changes to applied migrations. Add a new migration for deployed schema changes. The initial migration needs permission to create the `luma_identity` group role.

## API

The typed contract and OpenAPI document describe organization routes. Send the session cookie on authenticated requests and an allowed `Origin` header on mutations. CLI callers must supply both. Browser fetches through `/api` use same-origin cookies.

| Route                                                        | Behavior                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `POST /auth/sign-up/email`                                   | Register with name, email and a password of at least 12 characters                                |
| `POST /auth/sign-in/email`                                   | Sign in with email and password                                                                   |
| `GET /auth/get-session`                                      | Read the current session                                                                          |
| `POST /auth/sign-out`                                        | Revoke the current session                                                                        |
| `GET /v1/organizations`                                      | List only the caller's organizations                                                              |
| `POST /v1/organizations`                                     | Create an organization and its first owner atomically; accepts name, slug and optional dataRegion |
| `GET /v1/organizations/:organizationId/context`              | Resolve current membership, state, region and audit identity                                      |
| `GET /v1/organizations/:organizationId/members`              | List members of an authorized organization                                                        |
| `POST /v1/organizations/:organizationId/members`             | Add an existing user by UUID and role                                                             |
| `PATCH /v1/organizations/:organizationId/members/:memberId`  | Change a role                                                                                     |
| `DELETE /v1/organizations/:organizationId/members/:memberId` | Remove a member                                                                                   |

Owners and admins manage members; only owners may grant or revoke ownership. The last owner cannot be removed or demoted. Membership mutations serialize on the organization row and recheck the acting membership after acquiring the lock. Adding users is an explicit administrator action; email invitations and verification delivery are not enabled in this foundation.

The auth bridge also permits session listing/revocation and password changes. Other Better Auth routes, including direct organization routes, return 404. Organization creation uses Better Auth's organization plugin inside the identity transaction; Luma's API owns membership management and placement rules. Cookie cache and automatic account linking are disabled.

## Context and isolation

Every new Fastify route is protected by default. Only health, readiness, OpenAPI, the static connector-provider catalog and the restricted auth bridge are public. Organization listing/creation require a session. Tenant routes must use `/v1/organizations/:organizationId/...`; the guard resolves an immutable `request.tenantContext`. Pass it explicitly into application use cases. Public identity exports include `TenantContext`, `requireTenant` and `requireRole`; no database handles or auth instances escape the module.

A path ID selects a tenant; it does not grant access. Each request reads the current session and membership. `activeOrganizationId`, tenant headers and client-supplied context are never authorization inputs. Suspended/closed organizations return 404, unsupported placement returns 503, and US/APAC provisioning returns 422. Nonmembers and missing organizations both return 404; insufficient roles within an authorized organization return 403.

Audit identity contains user ID, initiating-user ID, session ID, membership ID, role, tenant, region and server request ID. It excludes passwords and session tokens. This is evidence metadata, not a durable audit log. Each later audit producer must write its own evidence envelope through the audit module.

The identity role has DML grants on auth tables and narrowly scoped grants on organization tables. It owns no tables and has no commerce grants. Organizations, memberships and invitations force RLS. Bootstrap reads expose only the verified user's memberships and organizations. Provisioning uses a server-generated organization UUID; tenant operations install context only after membership, state and placement checks. All context uses transaction-local `set_config`, including rollback and pooled reuse. Runtime grants prohibit changing tenant ownership, placement or organization status.

RLS prevents omitted filters; it does not protect against a compromised backend that sets arbitrary context. Credential/session tables are the ADR-003 regional bootstrap exception. Commerce modules must add their own scoped repositories, composite foreign keys, runtime roles and forced RLS policies when persistence is introduced.

## SSO and SCIM extension points

`AuthSettings.plugins` accepts reviewed Better Auth server plugins. Account/provider IDs remain separate from the canonical user UUID; organization UUIDs remain stable across future identity providers. Automatic account linking stays disabled until a verified linking policy is defined. Adding a plugin alone does not expose HTTP endpoints: extend the auth allowlist, migrations and tests deliberately.

Future SCIM provisioning must resolve a verified installation to one organization and recheck authority, state and placement before membership changes. Do not accept a tenant ID as proof of authority. Regional federation must preserve ADR-003's residency boundary. SSO, SCIM credentials and service actors are not enabled by this foundation.

## Verification

```sh
TEST_DATABASE_URL=postgresql://postgres:local_migration_password@127.0.0.1:5432/luma \
  pnpm check
```

The integration suite creates a uniquely named database and login, applies the migration, tests Better Auth through Fastify as the restricted login, and removes its fixtures. The supplied test account needs database/role creation permissions; never point it at production. `pnpm test` and `pnpm check` provision PostgreSQL through Testcontainers when `TEST_DATABASE_URL` is absent. Only `pnpm test:local` or direct package test commands skip integration suites without that variable.

Better Auth 1.7.5 uses Drizzle 0.45.2. `.pnpmfile.cjs` supplies Better Call 1.4.0's optional Zod 4 peer as a private dependency so it can coexist with ts-rest's Zod 3. Strict peer checks remain enabled. Reassess the hook when upgrading either dependency.

References: [Better Auth organization plugin](https://better-auth.com/docs/plugins/organization), [Fastify integration](https://better-auth.com/docs/integrations/fastify), [ADR-003](architecture/003-tenant-isolation-and-data-residency.md).

## Exception Desk web entry

The web app provides self-service email/password registration and sign-in at
`/sign-up` and `/sign-in`. `/app` opens workspace creation for users without a
workspace, the overview for users with one, or a selector for users with several.
Workspace URLs use organization UUIDs. Each tab selects its own workspace.

Protected routes use TanStack Start's `ssr: false`: session and membership reads
run in the browser through the same-origin API proxy. The server renders no
private content and forwards no session cookies for rendering. Each router still
owns its own QueryClient. Do not add server-side identity reads without forwarding
only the current request's cookies to a configured, trusted API origin.

Session and access reads refetch on focus and navigation. Private queries use the
`['private', 'organization', organizationId, ...]` prefix; switching workspaces
cancels and removes the previous workspace's queries. Session loss removes all
private queries. No query persistence or offline mutation queue is configured.
Creation requests are never automatically retried. After an uncertain workspace
creation, inspect the refreshed workspace list before starting another creation.

### Production proxy

Serve the web app and API under one HTTPS origin. Set `BETTER_AUTH_URL` to that
public origin and include it in `AUTH_TRUSTED_ORIGINS`. Forward `/api/` to the
trusted API service, removing only the `/api` prefix. Preserve `Cookie`, `Origin`
and every `Set-Cookie` header. Disable caching for auth and organization responses.
Never rewrite an untrusted Origin into a trusted one. For example, with Nginx:

```nginx
location /api/ {
    proxy_pass http://luma_api/;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Cookie $http_cookie;
    proxy_cache off;
    add_header Cache-Control "no-store" always;
}
```

`luma_api` is the deployment's fixed private API upstream. Forward all remaining
paths to the TanStack Start server. Keep secure, HttpOnly session cookies intact;
do not expose session tokens to JavaScript or browser storage. The development
Vite proxy applies the same path rewrite and preserves Origin and cookies.

### Browser acceptance suite

With a running container runtime:

```sh
pnpm --filter @luma/api exec playwright install chromium
pnpm test:browser
```

Use Node 24. The suite starts the compiled API with a restricted database login
and the actual Vite app on available loopback ports. It creates
and removes its own database, users and workspaces. Registration, sign-in,
organization writes and session revocation use real backend calls. Selected
network failures are injected at the browser boundary. Screenshots are written
to the system temporary directory. No production credentials are needed.

Verified on 18 September 2026 with Node 24, PostgreSQL 17 and Chromium:
`pnpm check`, `pnpm test:e2e` (3 scenarios), and `pnpm test:browser`
(3 scenarios) passed. Browser coverage includes zero/one/multiple workspaces,
registration with and without a session, uncertain writes, rejected origins,
return-path validation, tenant switching with a delayed response, separate tabs,
access revocation, recoverable service failures, sign-out, and keyboard navigation
at 1440×1000 and 390×844. The delayed-query unit check also verifies cancellation
and removal of the previous tenant's cache entries.
