# Authentication and organization access

Luma stores Better Auth users, credentials and sessions in its PostgreSQL database, and the `@luma/identity` package owns them. Organizations are tenants. Each membership has one role: built-in Owner, Admin or Member, or a custom workspace role, and roles grant permissions from a typed catalog; see [ADR-009](architecture/009-permissions-and-roles.md) and the [permission reference](permissions.md). Every tenant request is authorized from the current session and membership, never from caller-supplied context. V0 provisions only EU organizations.

## Database roles and configuration

The API connects with a restricted login: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, granted only the group roles it needs. Never give the API or worker migration credentials. `pnpm run setup` provisions the local logins; when you manage PostgreSQL yourself and run `pnpm dev:manual`, grant the same group roles that `tooling/dev/database.mjs` grants, or features fail with permission errors.

Migrations run through the shared runner in `@luma/application-runtime` in one transaction under an advisory lock. It records checksums in `identity_migrations` (the name predates the shared runner; it tracks every migration), skips applied files and rejects changes to applied ones. The initial migration needs permission to create the `luma_identity` group role.

The API needs `IDENTITY_DATABASE_URL` (the restricted login), `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `BETTER_AUTH_URL` (the public browser origin) and `AUTH_TRUSTED_ORIGINS` (exact browser origins). Production origins require HTTPS. `/ready` checks connectivity, migrated tables and the runtime role restrictions.

## Auth bridge

The web proxy forwards `/api/auth/*` to `/auth/*` and `/api/v1/*` to `/v1/*`. Better Auth uses `/auth` as its backend base path; its browser client must use the public `/api/auth` path. Mutations need the session cookie and an allowed `Origin` header; CLI callers must send both.

The bridge exposes only email sign-up (passwords of at least 12 characters), sign-in, session read, sign-out, session listing and revocation, password changes and the [sign-in factor](#sign-in-factors) routes. Every other Better Auth route, including its organization routes, returns 404. Organization creation uses Better Auth's organization plugin inside the identity transaction, creating the organization and its first owner atomically; Luma's API owns membership management and placement rules. Cookie cache and automatic account linking are disabled.

## Membership rules

- `members.manage` adds, reassigns and removes members. Only owners grant or revoke ownership. Nobody can assign a role, or change a member, with permissions the actor does not hold.
- The last owner cannot be removed or demoted.
- Membership mutations serialize on the organization row and recheck the acting membership after acquiring the lock.
- `workspace_people` keeps each workspace's current and former members for attribution.
  Triggers on memberships and user profiles maintain it, so no code path can skip it. Removal,
  including account deletion, keeps the last recorded name and drops the email. Reads are
  tenant-scoped under RLS; other domains name people through it instead of reading `users`.
- Adding an existing user by UUID remains an explicit administrator action. Email invitations, role management and access history are described in [workspace settings](workspace-settings.md).

## Sign-in factors

People can add an authenticator app (TOTP) as a second factor after their password, and passkeys that replace the password. Both are personal account settings. Like sessions and accounts, the factor tables have no tenant scope, and only `luma_identity` may change them.

- TOTP is pending until the first code is confirmed; until then, sign-in needs only the password. Enabling, regenerating backup codes and disabling all recheck the password. Setup returns the TOTP URI and 10 backup codes once.
- When TOTP is on, a correct password deletes the new session and returns `twoFactorRedirect` with a signed 10-minute challenge cookie. Each challenge allows five codes; ten failures lock code entry for 15 minutes. A backup code is consumed when used.
- Confirming setup and turning TOTP off rotate the session.
- Trusted devices are not supported: requests with `trustDevice` or `disableSession` are rejected. Code delivery by email or SMS, rereading the TOTP URI and renaming passkeys are not exposed.
- Registering a passkey needs a session created within the last day. A passkey sign-in counts as both factors and skips the code step.

The passkey relying-party ID is the `BETTER_AUTH_URL` hostname, and assertions are accepted only from `AUTH_TRUSTED_ORIGINS`. Browsers reject IP addresses as relying-party IDs, so local development serves the web app on `http://localhost:<port>`; `127.0.0.1` remains trusted for password sign-in only. Changing the production hostname invalidates existing passkeys. Passkeys created in one worktree are offered in others on `localhost`, but only work against the database that stored them.

With `NODE_ENV=production`, Better Auth rate-limits `/two-factor/*`, like sign-in, to three requests per 10 seconds per client IP. Without a forwarded client address all callers share one bucket, so the [production proxy](#production-proxy) must overwrite `X-Forwarded-For`. The limit store is per process; several API instances need shared storage before relying on these limits.

## Context and isolation

Every Fastify route is protected by default. Only health, readiness, OpenAPI, the static connector-provider catalog and the restricted auth bridge are public. Organization listing and creation need a session. Tenant routes use `/v1/organizations/:organizationId/...`; the guard resolves an immutable `request.tenantContext`, which handlers pass explicitly into application use cases.

Every tenant route declares who may call it: contract routes through `access` in their metadata (`requires(...)` or `anyMember` from `@luma/api-contract`), other routes through `config.access`. The guard denies routes without a declaration, and callers without the declared permission receive 403. No database handles or auth instances leave the identity package.

A path ID selects a tenant; it does not grant access. Each request reads the current session and membership. `activeOrganizationId`, tenant headers and client-supplied context are never authorization inputs.

| Situation                                        | Response |
| ------------------------------------------------ | -------- |
| Not a member, or the organization does not exist | 404      |
| Organization suspended or closed                 | 404      |
| Member without the required permission           | 403      |
| Organization placed in another region            | 503      |
| Provisioning in an unavailable region (US, APAC) | 422      |

The context carries an audit identity: user, initiating user, session, membership, role reference, tenant, region and server request ID, plus the role's effective permissions, resolved in the same membership statement. There is no long-lived permission cache. It never contains passwords or session tokens. It is evidence metadata, not an audit log; each audit producer writes its own evidence through the audit package.

The identity role has DML grants on auth tables and narrowly scoped grants on organization tables. It owns no tables and has no commerce grants. Organizations, memberships, invitations, workspace roles and role permissions force RLS; a member can read their own role before a tenant is selected, so context resolution needs no extra round trip. Bootstrap reads expose only the verified user's memberships and organizations. Provisioning uses a server-generated organization UUID. Tenant context is installed with transaction-local `set_config` only after membership, state and placement checks, so it does not survive rollback or pooled reuse. Runtime grants prohibit changing tenant ownership, placement or organization status.

Better Auth's `invitations` table remains because its organization plugin requires it; Luma uses `workspace_invitations`.

RLS prevents omitted filters; it does not protect against a compromised backend that sets arbitrary context. Credential and session tables are the regional bootstrap exception in [ADR-003](architecture/003-tenant-isolation-and-data-residency.md). Domain packages add their own scoped repositories, composite foreign keys, runtime roles and forced RLS policies.

## Browser sessions

Protected web routes use TanStack Start's `ssr: false`: session and membership reads run in the browser through the same-origin proxy. The server renders no private content and forwards no session cookies. Do not add server-side identity reads without forwarding only the current request's cookies to a configured, trusted API origin. Each router owns its own QueryClient; never share a server cache between users.

Workspace URLs use organization UUIDs, and each tab selects its own workspace. Private queries use the `['private', 'organization', organizationId, ...]` prefix. Switching workspaces cancels and removes the previous workspace's queries, and session loss removes all private queries. Session and access reads refetch on focus and navigation. There is no query persistence or offline mutation queue.

Workspace creation is never retried automatically. After an uncertain creation, refresh the workspace list before creating another.

## Production proxy

Serve the web app and API under one HTTPS origin. Set `BETTER_AUTH_URL` to that origin and include it in `AUTH_TRUSTED_ORIGINS`. Forward `/api/` to the trusted API service, removing only the `/api` prefix. Preserve `Cookie`, `Origin` and every `Set-Cookie` header. Replace `X-Forwarded-For` with the client address so auth rate limits apply per client. Disable caching for auth and organization responses. Never rewrite an untrusted Origin into a trusted one. For example, with Nginx:

```nginx
location /api/ {
    proxy_pass http://luma_api/;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_cache off;
    add_header Cache-Control "no-store" always;
}
```

`luma_api` is the deployment's fixed private API upstream. Forward all other paths to the TanStack Start server. Keep session cookies secure and HttpOnly; never expose session tokens to JavaScript or browser storage. The development Vite proxy applies the same rewrite and preserves Origin and cookies.

## SSO and SCIM extension points

`AuthSettings.plugins` accepts reviewed Better Auth server plugins. Adding a plugin does not expose HTTP endpoints: extend the auth allowlist, migrations and tests deliberately. Account and provider IDs stay separate from the canonical user UUID, and organization UUIDs stay stable across identity providers. Automatic account linking stays disabled until a verified linking policy exists.

SCIM provisioning must resolve a verified installation to one organization and recheck authority, state and placement before changing memberships. A tenant ID is never proof of authority. Regional federation must preserve ADR-003's residency boundary. SSO, SCIM credentials and service actors are not enabled.
