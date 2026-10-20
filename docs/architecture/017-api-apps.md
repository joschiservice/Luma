# ADR-017: API apps and the public API

Status: accepted · 2026-10-20 · [LUMA-379](https://linear.app/auren-labs/issue/LUMA-379)

## Context

Workspaces should be able to reach their own data without the web app: from scripts,
spreadsheets, BI tools and integrations. The oRPC contract already describes every route and
generates OpenAPI ([ADR-010](010-orpc-http-contracts.md)), but only a browser session can call
it. Mutations require a trusted `Origin`, and `TenantContext.actor` is always a person with a
session. Hundreds of call sites treat `actor.id` as a user ID: attribution, approvals, RLS user
context and workflow principals.

Three kinds of client need access. A member's own tools act for that member. Integrations a
workspace runs must outlive any one employee. External developers want apps any workspace can
install.

## Options considered

- **Personal access tokens, service accounts and OAuth clients as separate concepts.** Each
  would need its own listing, revocation, audit and admin screen. Workspaces would have to look
  in three places to see what can read their data.
- **Better Auth's API key plugin.** Its keys belong to a user, not a workspace. It brings its
  own permission metadata and rate limits, and it sits outside the auth bridge allowlist and
  tenant RLS. Narrowing a token to a workspace and to the person's current role would be
  rebuilt around it anyway.
- **A separate public API facade.** A curated set of endpoints maintained beside the contract.
  It drifts from what the product can do, which defeats the point of users owning their data.
- **API apps over the existing contract.** Every API client is an app that a workspace can see
  and revoke. Contract routes opt into the public API, and bearer requests resolve the same
  immutable tenant context as sessions.

## Decision

Use API apps over the existing contract, starting with personal apps.

- **Personal API apps.** A member with `api_apps.create` creates an app in workspace settings.
  The app acts for that member through a bearer token. It has the scopes they chose that their
  role still grants, recomputed on every request and context refresh. The actor stays the
  member, so attribution and approval rules are unchanged. `TenantContext.apiApp` marks the
  context, and `actor.sessionId` is the credential ID. Built-in Member holds `api_apps.create`;
  custom roles need an explicit grant.
- **Public routes.** Contract routes declare `publicApi: true`. The guard accepts a bearer token
  only on those routes, and only without cookies. Origin checks don't apply, because browsers
  never attach bearer tokens by themselves. Scopes are the read permissions of public routes,
  and a test keeps the two lists equal. Management routes, account routes and every other route
  need a signed-in person. A separate document, `/openapi.public.json`, lists the public routes.
- **Credentials.** Tokens are `luma_<cell>_` followed by 256 random bits and a CRC-32 checksum.
  The checksum lets secret scanners and the API reject typos and truncated tokens without a
  lookup, and a token from another cell gets `REGION_UNAVAILABLE`. Only SHA-256 hashes are
  stored, and the token is shown once. Every credential expires within a year. Rotation issues a
  new credential and revokes the old one in the same transaction.
- **Resolution before tenant context.** Bearer requests arrive before any tenant is known. The
  customer API resolves tokens only through `SECURITY DEFINER` functions owned by the login-less
  role `luma_api_credentials`. The runtime role can't read token hashes, and app management runs
  under tenant RLS.
- **Lifecycle.**
  - Apps belong to a membership: removing the member or erasing the account deletes them.
  - Suspending the membership blocks them until the membership is reactivated.
  - Disabling the account revokes them for good.
  - Closing the workspace stops them with the workspace.
- **Limits and evidence.**
  - Each token and each workspace has a per-minute limit in the shared auth counter store.
    Responses report the tighter one in `RateLimit-*` headers, and exceeding it returns `429`
    with `Retry-After`.
  - Creating, rotating and revoking an app are workspace access events.
  - Use is recorded at most once a minute.
  - Reads of customer personal data are counted per token, route and hour, with the number of
    records returned and never the records. The first read of a route in an hour is an access
    event. An event per request would bury Activity under a paging script, and a count kept in
    memory would be lost on restart. Recording happens before the response is sent and fails
    the request when it fails.
  - The person an app acts for is emailed a week before its token expires and when someone else
    revokes it.
- **Change feed.** `/changes` lists which public records changed, by type and ID, never their
  content; clients reread the record through its own route. Triggers on the tables behind each
  record write one row per record and transaction, in the writing transaction.
  - Rows are ordered by transaction ID and served only once every older transaction has
    finished. A sequence or timestamp is taken before commit, so a reader could pass a value
    whose transaction commits later and skip that change for good. The cost is that one long
    transaction anywhere in the cluster delays the feed.
  - Rows are kept for 30 days. A cursor before the pruned position gets `410`, and the client
    rereads everything; an unbounded log would grow with every sync.
  - Purging a closed workspace records nothing. Removing one connection's data, such as a Shopify
    shop redaction, and customer erasure record deletions, so copies kept outside Luma learn of
    them.
  - Payloads in the feed were rejected: they would duplicate each route's permission and
    personal-data handling, and every record shape change would become a feed change too.
- **Later kinds of app.** Workspace-owned apps and public apps installable by any workspace act
  as themselves, not as a person. They need a non-user principal, which is the groundwork in
  [LUMA-56](https://linear.app/auren-labs/issue/LUMA-56). They use the same credentials,
  public-route admission and admin listing. Public apps are installed through OAuth 2.1 with
  PKCE, without review by Luma, and Luma staff can suspend them.

## Consequences

- A route becomes part of the public API by declaring `publicApi`. From then on, the `/v1`
  compatibility rules in the [API guide](../api.md#contract-rules) bind it for external
  callers, not just the web app.
- Adding a scope means marking its read routes public. The scope test fails until both lists
  match.
- A table that backs a public record needs the `workspace_change` triggers, or copies kept
  through the feed silently go stale.
- Writes through API apps aren't possible yet. They need action admission and approval rules in
  which an app is its own requester, so that an app can't satisfy the approval of the person who
  created it.
- Durable work started by an API app context would continue as the member. No public route
  starts durable work today. Writes must settle this before they're opened.

Reversal cost: medium. Removing bearer admission from the guard disables every token at once.
The tables and functions are self-contained.
