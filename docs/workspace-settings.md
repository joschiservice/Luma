# Workspace settings

Settings is available at `/app/:organizationId/settings/workspace`, with direct
links to `/team`, `/notifications` and `/approvals`. Workspace controls are shared;
notification choices belong to the signed-in user in that workspace.

Owners and admins may change the workspace name, display timezone and approval
preference. Slug and region are read-only. Members can read workspace settings and
manage their own email preferences. Only owners grant or revoke ownership. Team
mutations recheck authority under the organization lock, including concurrent
last-owner changes. Access and policy changes retain actor, timestamp and bounded
before/after evidence in the append-only `workspace_access_events` table.

## API and retries

All settings routes use the typed `settings` contract. Workspace routes are under
`/v1/organizations/:organizationId/settings`:

| Method and suffix                 | Behavior                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /`                           | Workspace controls, personal preferences, email availability and latest test delivery |
| `PATCH /workspace`                | Name and IANA timezone, with the reviewed workspace revision                          |
| `PATCH /approvals`                | Approval preference, with the reviewed policy revision                                |
| `PATCH /notifications`            | Personal email preferences, with their reviewed revision                              |
| `POST /notifications/test`        | Queue an email to the caller                                                          |
| `GET /invitations`                | Administrator invitation list, including expiry and delivery state                    |
| `POST /invitations`               | Invite an email address as member or admin                                            |
| `POST /invitations/:invitationId` | Resend or revoke the reviewed generation                                              |
| `GET /commands/:commandId`        | Check whether the caller's settings command committed                                 |

Writes require a UUID `commandId`. Exact retries return the original result;
reusing an ID for another actor or payload returns 409. After an uncertain
response, check the command receipt, then retry the identical command if needed.
Version conflicts require refreshing the relevant settings before a new write.
Forms retain input on failure and do not queue offline writes.

Membership reads and changes continue to use `/members`. Reads include display
name and email. Role changes and removals accept an `x-command-id` UUID header. The Team screen
retries the original command; durable receipts prevent overwriting subsequent changes.

## Invitations

Invitations expire after seven days. Sending mail never creates a membership.
Duplicate pending or expired invitations return 409; resend the existing invitation.
Already-member email addresses also return 409. Resending increments the generation,
replaces the token and restarts expiry. Revocation invalidates the link immediately.

`POST /v1/invitations/preview` and `/accept` require a session and trusted Origin.
Both receive `organizationId`, `invitationId` and `token`. Acceptance checks the
workspace, email, expiry, token and pending status under the same organization lock
used by membership edits. Consumption and membership creation commit together.
Reusing an accepted link returns 404, even after access is subsequently removed.
The browser reconciles a lost acceptance response against its workspace list.

The invitation token stays in the browser URL fragment, tab-local session storage during sign-in, and POST body. It is not
sent in navigation requests or retained in audit evidence. Only its hash is stored.
The mail worker derives the link using the identity signing secret; resend pending
invitations after rotating that secret. Never log mail contents or acceptance bodies.

## Email delivery

Apply migration `0023_workspace_settings.sql`, then configure all three API variables:

```dotenv
MAIL_RESEND_API_KEY=re_...
MAIL_FROM=Luma <notifications@example.com>
MAIL_PUBLIC_ORIGIN=https://app.example.com
```

Use a verified Resend sender and the public web origin. Without configuration,
Settings reports delivery unavailable and disables invitations and test sends.
Personal preferences still persist; optional email starts off. Configure the same
provider, public origin and identity signing secret on every API replica.

The API drains a PostgreSQL queue every five seconds. Source transactions enqueue
opted-in members when an issue needs approval, manual intervention or uncertainty
review, or a connection becomes degraded/revoked. Issue attention is deduplicated
per incident and recipient; connection messages are deduplicated per lifecycle
version and recipient. No historical events are backfilled when a user opts in.
The worker rechecks membership, workspace state and preference in a short transaction
before dispatch. Provider calls run outside operational locks. A message already
dispatched may complete after opt-out or membership removal. Opting out cancels queued optional messages.
Invitation delivery also rechecks the inviter's management role and link generation.

Delivery attempts are committed before the provider call. Stable message IDs are
Resend idempotency keys. Network calls time out after eight seconds; retries use
bounded exponential backoff, at most five attempts and less than 23 hours from the
first attempt. This stays within [Resend's 24-hour deduplication window](https://resend.com/changelog/idempotency-keys),
including after process failure. Expired retry windows fail without sending again.
`sent` means the provider accepted the message; it does not certify inbox receipt.
Failed invitations can be resent; failed test messages can be tried again.

The mail-provider port accepts only destination, subject, plain text and a stable
message ID. Messages contain authorized issue/connection links and no provider
payloads. Tests inject a deterministic provider through trusted composition; no
public test-mailbox endpoint is exposed. Queue tenant discovery and source triggers
run as the migration owner, which needs RLS-bypass privileges; runtime connections
remain restricted and tenant tables force RLS.

## Timezone and approvals

Timestamps remain UTC. The shared `WorkspaceDate` component formats visible dates
using the selected IANA timezone. Activity and Shadow reporting use workspace day
boundaries, including daylight-saving transitions. The default is UTC.

The workspace approval preference can only strengthen platform policy. It requires
independent owner/admin approval even for otherwise allowed low-risk changes.
Disabling it restores platform rules. Capability restrictions, denial, verification
and action admission remain mandatory.

Changing the preference increments the policy revision. Decisions and approvals
bind to that revision. Old reviews lose their decision controls and show a refresh
notice; old approvals do not carry forward. Admission re-evaluates policy, the
reservation fence checks the current revision, and dispatch checks it again after
audit persistence. Previously rejected intent stays rejected across revisions.

## Personal layouts and appearance

`GET /v1/organizations/:organizationId/settings/layout` returns the signed-in
member's Home modules and sidebar pins for that workspace. A `home` of `null`
means the default Home. `PUT` on the same path saves the whole layout with the
revision last read; a stale revision returns 409 and the client reloads the
latest layout. Any member can save their own layout; layouts are never shared
with teammates. Each module appears at most once, pins are limited to 12, and a
pin's path is relative to the workspace root, such as `exceptions?view=active`.
Unknown module IDs from older layouts are dropped when read. Migration
`0033_workspace_layouts.sql` stores layouts per tenant and member under row-level
security.

**Settings → Appearance** stores the theme (system, light or dark) and the
default sidebar width in the browser, so they apply to the current device.
**Settings → Home & sidebar** manages the stored layout.

## Validation

```sh
pnpm test:e2e settings.e2e.mjs
pnpm test:browser settings.browser.mjs
pnpm check
```

The backend suite covers permissions, tenant isolation, revision conflicts, command
replay, last-owner concurrency, invitation acceptance/reuse/expiry, mail failures,
notification deduplication, opt-out, removal, retry windows, effective policy and
personal layout revisions, validation and isolation.
Browser acceptance covers timeout recovery, preferences after refresh, keyboard
approval controls, email invitation and acceptance, role changes, removal and narrow
screens. Settings Storybook stories cover workspace, personal preferences, member
access, approval policy, unavailable delivery, loading and recovery.
