# ADR-011: Read-only support view

Status: accepted · 2026-10-10 · [LUMA-163](https://linear.app/auren-labs/issue/LUMA-163)

## Context

Some customer problems only reproduce with exactly what one person sees: their permissions,
Home layout, filters and data. Staff inspection shows metadata, not the product. Full
impersonation would let staff act as the customer, and attribute staff actions to them.

## Options considered

- **Impersonation through a customer session.** Staff receive a Better Auth session for the
  member. Every write path would need to tell staff and customer apart afterwards, and a
  leaked session is a full customer credential.
- **A separate support origin.** A second deployment of the web app and API that accepts only
  support credentials. Strong isolation, but another origin, certificate, proxy and cookie
  configuration per environment.
- **Staff-side rendering.** The staff console renders customer pages from staff APIs. It would
  duplicate every page and drift from what customers see.
- **A staff-derived, read-only tenant context in the customer API.** The customer app and API
  serve the view; a separate, short-lived credential selects a support context instead of a
  customer session.

## Decision

Serve the support view from the customer app and API with a staff-derived, read-only tenant
context.

- **Credential.** The staff console starts a view and opens the customer origin with a
  single-use handoff token in the URL fragment. The customer API exchanges it, within two
  minutes, for a random token in its own host-only, HttpOnly, `SameSite=Strict` cookie. Only
  hashes are stored. It is never a Better Auth session, and Better Auth never reads it.
- **Precedence.** While the support cookie is present, tenant routes, the workspace list and
  live streams use the support context and ignore any customer session in the same browser.
  Account routes (security events, invitations, workspace creation) refuse it.
- **Context.** `TenantContext.supportView` marks the context. The actor is the target member,
  with that member's current role and permissions, so pages, Home layout and filters match
  theirs. `refreshContext` keeps the mark.
- **Read-only, three times.** The request guard refuses every route that is not `GET` or
  `HEAD` unless its contract or route config declares `readOnly: true`, before resolving
  permissions. The request scope is restricted to reads, so the API's tenant database
  transactions open as `READ ONLY`. Execution admission, approvals and Ask Luma refuse a support context
  themselves (`requireChangesAllowed`), so a future read route that reaches them still fails.
- **Validity on every request.** One identity-owned SQL function, owned by
  `luma_support_view`, checks the view on each request and live-stream recheck: not ended,
  within 30 minutes of its start, the staff member still admitted with the permission and the
  staff session alive, and, for consented views, the workspace's consent still active. A
  failed check ends the view and writes the end evidence in the same statement, so revoking
  consent ends active views on their next request. A minute-by-minute sweep writes the end of
  views nobody used again.
- **Authority to start.** A current workspace support grant, the target's active membership,
  and either `staff.view-as` with the workspace's consent or `staff.view-as.emergency` with a
  reason category, reference and a staff sign-in within fifteen minutes.
- **Consent.** `support_access.manage` holders allow access for 24 hours, 3 days or 7 days, or
  revoke it, in workspace settings. Staff can request access; the same people approve or
  decline the request. Changes are workspace access events.
- **Evidence.** Start, the first read of each API path in a view, and end are written to
  `staff_audit` and to `workspace_access_events`, which customers see in Activity. Owners
  receive email when a consented view starts, and when an emergency view ends.

## Consequences

- One customer app serves both customers and support, so the support view cannot drift from
  what customers see.
- Every new non-`GET` route is refused in support views by default. A route that only reads
  but needs a request body must declare `readOnly: true`; a `GET` route must not write.
- Reads are sampled per path: repeated reads of the same path in one view are not recorded
  again, but every distinct record and list path is.
- The customer API's runtime role can resolve support views only through the SQL functions;
  it cannot read staff tables directly.
- A browser holding the support cookie cannot use its own customer session for tenant routes
  until the view ends.

Reversal cost: medium. The context mark and the guard's read-only rule are local; the
consent and evidence tables would remain as history.
