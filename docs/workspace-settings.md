# Workspace settings

Workspace settings cover the workspace name and timezone, team access, custom roles, the approval preference, email delivery and each member's notification choices and personal layout. Workspace controls are shared; notification preferences and layouts belong to the signed-in member in that workspace. Every access and policy change is serialized, retry-safe and recorded with bounded before/after evidence. The typed `settings` and `roles` contracts are the API reference.

## Authority

- Every member can read workspace settings and manage their own email preferences and layout.
- `workspace.settings.manage` changes the name and display timezone. Slug and region are read-only.
- `workspace.approval_policy.manage` changes the approval preference.
- `members.manage` invites, reassigns and removes people. Only owners grant or revoke ownership, and nobody can assign a role with permissions they do not hold. The [membership rules](identity.md#membership-rules) apply.
- `roles.manage` creates, edits and archives custom roles and reads role history.

Sections a role cannot change say which permission they need. Team and role mutations recheck authority under the organization row lock, including concurrent last-owner changes. Access, role and policy changes are appended to `workspace_access_events` with actor, timestamp and bounded before/after values.

## Roles

Built-in roles are read-only; custom roles start as a copy. A role edit is saved against the reviewed `revision`, and the editor sees the people it affects before saving. Archiving needs the role to be unused and revokes its pending invitations, which then show as revoked by archive. Role history returns up to 100 changes and assignments. See [ADR-009](architecture/009-permissions-and-roles.md) and the [permission reference](permissions.md).

## Commands and retries

Settings writes require a UUID `commandId`; membership and role writes take an `x-command-id` header. An exact retry returns the original result; reusing an ID for another actor or payload returns 409. After an uncertain response, read the command receipt, then retry the identical command if it did not commit. Durable receipts keep a late retry from overwriting later changes.

Each editable object carries a revision. A stale revision returns 409; refresh before writing again. Forms keep their input on failure and never queue offline writes.

## Invitations

- Invitations expire after seven days. Sending mail never creates a membership.
- A duplicate pending or expired invitation, or an address that is already a member, returns 409; resend the existing invitation instead.
- Resending increments the generation, replaces the token and restarts expiry. Revoking invalidates the link immediately.
- Preview and acceptance require a session and a trusted Origin. Acceptance checks the workspace, email, expiry, token and pending status under the same organization lock as membership edits, and consumes the invitation and creates the membership in one transaction.
- Reusing an accepted link returns 404, even after access is later removed. The browser reconciles a lost acceptance response against its workspace list.

The token travels only in the URL fragment, tab-local session storage during sign-in and the POST body. It is never sent in navigation requests or kept in audit evidence, and only its hash is stored. The mail worker derives links with the identity signing secret, so resend pending invitations after rotating `BETTER_AUTH_SECRET`. Never log mail contents or acceptance bodies.

## Email delivery

Configure all three API variables with a verified Resend sender and the public web origin:

```dotenv
MAIL_RESEND_API_KEY=re_...
MAIL_FROM=Luma <notifications@example.com>
MAIL_PUBLIC_ORIGIN=https://app.example.com
```

Without them, Settings reports delivery unavailable and disables invitations and test sends; personal preferences still persist, and optional email starts off. Every API replica needs the same provider, public origin and identity signing secret.

The API drains a PostgreSQL mail queue every five seconds. Source transactions enqueue opted-in members when an issue needs approval, manual intervention or uncertainty review, or a connection becomes degraded or revoked.

- Issue messages are deduplicated per incident and recipient; connection messages per lifecycle version and recipient. Opting in does not backfill past events; opting out cancels queued optional messages.
- Before dispatch, a short transaction rechecks membership, workspace state and preference. Invitations also recheck that the inviter still holds `members.manage`, that a custom role is still active and the link generation. A message already dispatched may still arrive after opt-out or removal.
- Attempts are committed before the provider call, and provider calls run outside operational locks. The stable message ID is the Resend idempotency key.
- Calls time out after eight seconds. Retries back off exponentially, with at most five attempts, all within 23 hours of the first. That keeps every retry inside [Resend's 24-hour deduplication window](https://resend.com/changelog/idempotency-keys), including after a process crash. An expired retry window fails without sending again.
- `sent` means the provider accepted the message, not that it reached the inbox. Failed invitations can be resent; failed test messages can be retried.

The mail port accepts only destination, subject, plain text and message ID. Messages contain authorized issue or connection links and no provider payloads. Tests inject a deterministic provider through composition; there is no public test-mailbox endpoint. Queue tenant discovery and source triggers run as the migration owner, which needs RLS bypass; runtime connections stay restricted.

## Timezone

Timestamps are stored in UTC; the default display timezone is UTC. `WorkspaceDate` formats visible dates in the workspace's IANA timezone, and Activity and Shadow reporting use workspace day boundaries, including daylight-saving transitions.

## Approval preference

The workspace approval preference can only strengthen platform policy: when on, even otherwise allowed low-risk changes need independent approval by someone else with `decisions.respond`. Turning it off restores platform rules. Capability restrictions, denial, verification and action admission stay mandatory either way.

Changing the preference increments the policy revision, and decisions and approvals bind to that revision:

- Reviews made under an old revision lose their decision controls and show a refresh notice. Old approvals do not carry forward.
- Admission re-evaluates policy, the reservation fence checks the current revision, and dispatch checks it again after audit persistence.
- Rejected intent stays rejected across revisions.

## Personal layouts

Each member stores their own Home modules and sidebar pins per workspace; layouts are never shared. A `home` of `null` means the default Home. Saving replaces the whole layout at the revision last read, and a stale revision returns 409 so the client reloads. Each module appears at most once, pins are limited to 12, and a pin's path is relative to the workspace root, such as `exceptions?view=active`. Unknown module IDs from older layouts are dropped on read.

Theme and default sidebar width are device preferences stored in the browser, not in the layout.
