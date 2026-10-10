# Staff access

The staff console provides customer account lookup, account and workspace inspection and
controlled session revocation. Its identities, sessions and permissions are separate from customer
workspace access. Customer Owners and Admins cannot grant staff privileges.

## Authentication and provisioning

Production sign-in uses Google Workspace through the shared `@luma/identity-provider`
OIDC adapter. Better Auth handles discovery, authorization codes, PKCE, state and signed
ID-token validation, including issuer, audience and nonce. The shared adapter additionally
requires verified email, the configured Google hosted-domain claim and an explicitly
approved immutable provider subject. The domain hint on Google's login page is not proof
of Workspace membership. Automatic account linking and direct browser ID-token sign-in
are disabled.

The adapter verifies identities; it never grants application permissions or creates
customer memberships. Future customer SSO must separately bind a reviewed provider
installation to its workspace, validate placement and enforce that workspace's provisioning
policy. A staff grant cannot be reused for customer access.

Staff enrollment is an administrator operation, outside the running API's credentials.
Bind the verified Google subject to an email and an explicit permission set. Record the
operator and reason when provisioning, changing or revoking the grant. Obtaining a subject
requires a trusted Workspace administration process; never accept a subject copied from an
unverified browser token. Google offboarding should also deactivate Luma's staff grant:
Google login policy alone does not revoke an already issued Luma session.

After building `@luma/staff-api`, provision admission from a restricted administrator
terminal. Supply `MIGRATION_DATABASE_URL` through your secret manager or a protected
environment file; it is not part of the running staff API configuration. Prepare a
protected JSON file with the verified Google `subject`, `email`, explicit `permissions`,
boolean `active`, administrator `operator` and a `reason` of ten to five hundred characters:

```json
{
  "email": "support@example.com",
  "subject": "verified-google-subject",
  "active": true,
  "permissions": ["staff.directory.read", "staff.workspace.inspect"],
  "operator": "administrator@example.com",
  "reason": "Approved support access for the workforce team"
}
```

```sh
pnpm --filter @luma/staff-api staff:provision --input /secure/path/staff.json
```

Run the same command with `active: false` to revoke admission, or with a reviewed
permission list to change access. Deactivation or changes to the bound subject or
permissions delete existing staff sessions and their support grants in the same
transaction. Subject rebinding also replaces the Google account binding through this
explicit administrator operation, preserving the staff principal and its audit history.
Google sessions retain the verified subject from their sign-in. A session without a
matching subject is rejected, including an old callback that finishes after rebinding.
Sessions also recheck admission on every request. The administrator operation records
its operator, reason and resulting grant atomically; the running
staff credentials cannot perform it. Opening workspace support grants
requires both `staff.directory.read` and `staff.workspace.inspect`; opening account grants
requires `staff.directory.read` and `staff.accounts.inspect`. Global customer
session revocation additionally requires `staff.sessions.revoke`. Reviewing the staff audit
log requires `staff.audit.read`; grant it separately, to the people accountable for
reviewing support work, not as part of a support role.

Configure Google's OAuth client as an internal Workspace application and register
`https://<staff-host>/api/auth/callback/google` as its exact authorized redirect URI.
Set the staff origin and hosted domain to match the reviewed deployment; use separate
Google OAuth credentials from the customer application.

Google Workspace must enforce two-step verification for the authorized staff population.
Google's ID token does not establish that a particular login satisfied your company's MFA
policy. The deployment owner must enforce that policy in Workspace and the workforce
access gateway; the console must not label an ordinary OIDC token as proof of MFA.

Local sign-in uses an isolated email/password account. It is rejected in production and
requires loopback origins, listeners and databases. Managed setup generates a separate
random staff password, signing secret, database login and ports for each checkout. Login
details live in ignored `.luma/staff.json`; never copy that state between worktrees.
Use `pnpm dev:staff` to run the staff surface against this checkout's database.

## Authority and evidence

Staff permission keys belong to a separate catalog. Never add them to the customer catalog:
its built-in Owner and Admin roles automatically receive every core permission. The
`staff_access` permission check lists the same keys, so a new key needs a migration that
redefines it with the complete list.

Directory access exposes bounded user/workspace metadata. Customer detail requires a
workspace support grant with a reason, bound to the current staff identity and session,
and valid for thirty minutes. Grants are checked again on every read and command. Database
policies preserve workspace boundaries without inserting artificial customer memberships.
Inspection can support suspended workspaces; it grants no commerce execution authority.

Account detail requires an account support grant for one customer account, with the same
reason, staff session binding and thirty-minute limit. It shows the person's workspaces and
roles, whether two-factor authentication is on, how many passkeys are registered, and active
sessions with their IP address, approximate browser and operating system, and last activity.
It never returns credentials, factor secrets or passkey credential IDs. An account grant opens
no workspace: workspace detail and session revocation still need a workspace grant. Restricted
views expose only the listed columns, and only under a current account grant. Opening a grant
is audited as `account.access.opened` and each read as `account.inspected`. IP addresses and
user agents come from the customer's requests; treat them as hints, not proof of device or
location.

The account page also pages through the account's
[security events](identity.md#security-events), 25 at a time, under the same grant. Each page
is audited as `account.security-events.inspected`. Email hashes for unknown-email failures are
not exposed. Events older than 90 days have no IP address or user agent, and events older
than a year are gone. Staff session revocations appear with their command ID.

Staff sessions have an eight-hour absolute lifetime and a thirty-minute idle limit.
Passive polling does not extend the idle deadline. Only browser interaction reported on
private requests advances activity; background refresh and focus checks still resolve
current access. Access is resolved from current storage, without a browser cookie
permission cache. Revoking customer sessions additionally requires staff authentication
within fifteen minutes.

Customer session revocation affects the account across all of its workspaces. The UI and
API require explicit acknowledgement of that effect. The identity-owned operation checks
the target's membership, current staff permission and support grant, and records a durable
command receipt and audit evidence in the same transaction as session deletion. An exact
retry returns the original receipt; another payload or actor cannot reuse that command ID.

Support evidence records the real staff operator and session, target workspace, reason,
request and outcome. Sign-in outcomes, sign-out and sensitive reads are also audited.
Support operations fail if their audit evidence cannot be recorded. New session cookies
are withheld until authentication audit writes succeed. Staff runtime credentials
cannot update or delete the support audit log, grant
staff privileges, or directly delete customer sessions. Provider credentials and commerce
payloads are not included in the support response or general telemetry.

## Staff audit review and retention

Staff with `staff.audit.read` can page the audit log in the console, newest first, filtered
by staff member, workspace, account, event and time range. Each read is recorded as
`staff.audit.read` with its filters. The runtime still has only INSERT on `staff_audit`; reads
go through `staff_audit_entries`, owned by the separate `luma_staff_audit` role, which rechecks
the permission. Filters use plain indexed columns. The account filter matches entries whose
details carry a `userId`, stored as the generated `account_id` column; record `userId` in the
details of new account-level events so they stay findable. Directory searches list matching
accounts in their details but are not account entries.

Entries are written only when their operation commits, so reads and commands appear only when
they succeeded; `*.failed` events, such as failed sign-ins, record failures. Workspace, account
and staff names come from current records and disappear when the record is deleted; the
entry keeps the ID. Links from an entry still require a support grant or directory access.

The staff audit is accountability evidence and is retained long-term. Nothing deletes or
updates its rows automatically, and workspace or account deletion must leave them in place:
entries hold workspace and account IDs without foreign keys. Staff identities that appear in
the audit stay in `staff_users`; revoke admission instead of deleting them.

## Workspace health and access history

Under a support grant, the workspace page also shows health and access history. Health
covers sync streams and runs, connection versions, lifecycle changes and latest read checks,
actions with an unknown outcome or failure, workflow steps that need review, case and approval
counts, failed workspace mail, installed apps and workspace settings. Access history lists
member, invitation, role, policy and workspace changes with names from the workspace's people
records; people without a record appear as unknown with a short ID.

These reads expose metadata, codes and counts only. The staff runtime reads them through
`staff_health_*` and `staff_access_history` views owned by `luma_staff_views`; it has no grant on
the source tables. Keep it that way: the restricted-role test allowlists every customer column
the runtime can select and rejects payload-like view columns. Never project connection targets
or secrets, read-check documents (successful checks contain provider observations), action
parameters, step values, invitation addresses or other before/after values. Sync error messages
are Luma's fixed text for an error code, capped in length; review any new free-text column for
provider text and personal data before exposing it.

Row security on every source table limits the view owner to the workspace of the caller's
current grant, evaluated once per statement. That policy applies before caller-supplied
conditions, so the views need not be security barriers and ordered reads use tenant indexes.
Every list holds the 20 most recent entries and marks truncation; action, mail and admission
counts stop at 1,000. Access history pages hold 50 events, keyed by event time and ID. Each
health read and history page is audited as `workspace.health.read` or
`workspace.access-history.read`. The page refreshes health once a minute and history only on
request, because every read writes audit evidence.

Health is diagnostic evidence, not a verdict: a quiet health view does not establish that an
issue is resolved. Actions with an unknown outcome may have changed the provider and need
verification, not a repeat.

## Deployment boundary

Serve the frontend on its own HTTPS origin. Proxy its `/api/` path exclusively to the staff
API, removing that prefix; preserve cookies, `Origin` and `Set-Cookie`. Keep customer and
staff cookies host-only with separate names and signing secrets. Staff cookies must not be
shared with sibling subdomains. API mutations validate the exact staff origin; SameSite
cookies and CORS do not replace that check.

Protect both the staff website and API ingress with the workforce access gateway or a
private network. The upstream must not be independently reachable through a public
listener, alternate hostname or the customer API. The API still authenticates and authorizes
each request. If a gateway forwards identity headers, strip client-supplied values and
validate the gateway's assertion before treating them as identity evidence.

Set `STAFF_TRUSTED_PROXY` to the reviewed ingress IP addresses or narrow CIDR ranges,
separated by commas. Production Google authentication requires this setting; other modes
trust no forwarded addresses by default. Prefer exact proxy IPs. IPv4 prefixes must be
`/24` or narrower and IPv6 prefixes `/120` or narrower, limiting each trusted range to 256
addresses. Hostnames, symbolic ranges, booleans and hop counts are rejected because they
could trust unintended callers. Keep the trusted ranges limited to the ingress service.

The trusted proxy must replace incoming `X-Forwarded-For` with the verified client address.
If several proxies participate, each retained hop must be verified and explicitly trusted.
Fastify stops the address chain at the first untrusted hop; the auth bridge then strips
forwarding headers and supplies only that resolved address to Better Auth. Direct callers
cannot change their authentication limiter key by supplying address headers. Incorrect
proxy trust collapses clients into a shared limiter bucket or lets callers evade limits.
For example, a same-host reverse proxy can use `STAFF_TRUSTED_PROXY=127.0.0.1` while
overwriting the forwarded address from its verified upstream connection. Authentication
limits are per API process; use a gateway limiter or shared storage before relying on them
across several API instances.

Serve private responses with `Cache-Control: no-store`. Apply a restrictive content security
policy and `frame-ancestors 'none'` to the frontend. Keep the staff API, database, support
records and gateway processing in the approved regional path described in
[tenant isolation and residency](architecture/003-tenant-isolation-and-data-residency.md).

Apply migrations through the shared migration runner, using separate migration credentials.
Provision the staff database login as `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
and grant only `luma_staff_runtime`. Do not grant customer domain roles or the internal
roles that own privileged support functions. The staff readiness check rejects unsafe
runtime credentials. Configure server-only values from `apps/staff-api/.env.example`;
OAuth secrets and database URLs must never appear in `VITE_*` configuration.
