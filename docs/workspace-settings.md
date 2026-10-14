# Workspace settings

Workspace settings cover the workspace name, timezone and detection limits, team access, custom roles, the approval preference, email delivery and each member's notification choices and personal layout. Workspace controls are shared; notification preferences and layouts belong to the signed-in member in that workspace. Every access and policy change is serialized, retry-safe and recorded with bounded before/after evidence. The typed `settings` and `roles` contracts are the API reference.

## Authority

- Every member can read workspace settings and manage their own email preferences and layout.
- `workspace.settings.manage` changes the name, display timezone and source authority. Slug and region are read-only.
- `workspace.approval_policy.manage` changes the approval preference.
- `members.manage` invites, reassigns and removes people. Only owners grant or revoke ownership, and nobody can assign a role with permissions they do not hold. The [membership rules](identity.md#membership-rules) apply.
- `roles.manage` creates, edits and archives custom roles and reads role history.
- `support_access.manage` allows and revokes Luma support access and answers support requests.

Sections a role cannot change say which permission they need. Team and role mutations recheck authority under the organization row lock, including concurrent last-owner changes. Access, role and policy changes are appended to `workspace_access_events` with actor, timestamp and bounded before/after values.

## Detection limits

Workspace settings control stock tolerance, the ordinary stock confirmation window, the
shorter oversell window and the fulfillment progress limit. Oversell risk defaults to two
minutes; other stock gaps default to thirty minutes. Zero confirms stock gaps immediately.
Only current, complete, comparable evidence can raise an issue. Each evaluation records its
configuration, and issue details show the limits used. A setting change requires fresh
detection and review before a stock correction can run.

## Source authority

Source authority chooses a connection for each order fact group and for inventory stock
and selling source. Every member can review the settings; `workspace.settings.manage`
changes one override or restores its category default. The server validates the tenant,
connection availability and read grants. Inventory selling authority requires a storefront.

Defaults prefer storefront order lines and lifecycle, ERP fulfillment and tracking, ERP
stock and storefront selling. Order groups fall back to the other category when the
preferred category has no eligible connection. Multiple preferred sources conflict;
unavailable overrides stay unknown instead of reverting to a default. Unknown or
conflicting authority defers workspace inventory comparisons and cannot authorize a correction.

Overrides use a workspace revision and a stable command ID. Concurrent edits at the same
revision allow one winner; exact retries return the original audit receipt. History retains
who changed the override, its previous and new connection, revision and timestamp. Reads
use current configuration without changing source snapshots or old comparison evidence.
An override revision change supersedes inventory diagnosis recommendations and invalidates
reviewed Shopify stock corrections; fresh detection and review are required.

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

Configure all three API variables with a verified Resend sender and the public web origin. The webhook secret is optional; see [delivery events](#delivery-events).

```dotenv
MAIL_RESEND_API_KEY=re_...
MAIL_FROM=Luma <notifications@example.com>
MAIL_PUBLIC_ORIGIN=https://app.example.com
MAIL_RESEND_WEBHOOK_SECRET=whsec_...
```

Without them, Settings reports delivery unavailable and disables invitations and test sends; personal preferences still persist, and optional email starts off. Every API replica needs the same provider, public origin and identity signing secret.

Mail goes through three PostgreSQL queues: password mail, account notices and workspace mail. The API drains them every five seconds, in that order, through one dispatch step that renders the message and calls Resend. Source transactions enqueue opted-in members when an issue needs approval, manual intervention or uncertainty review, or a connection becomes degraded or revoked.

- Issue messages are deduplicated per incident and recipient; connection messages per lifecycle version and recipient. Opting in does not backfill past events; opting out cancels queued optional messages.
- Before dispatch, a short transaction rechecks membership, workspace state and preference. Invitations also recheck that the inviter still holds `members.manage`, that a custom role is still active and the link generation. A message already dispatched may still arrive after opt-out or removal.
- Attempts are committed before the provider call, and provider calls run outside operational locks. The stable message ID is the Resend idempotency key.
- Calls time out after eight seconds. Retries back off exponentially, with at most five attempts, all within 23 hours of the first. That keeps every retry inside [Resend's 24-hour deduplication window](https://resend.com/changelog/idempotency-keys), including after a process crash. An expired retry window fails without sending again.
- A rate-limited request was never processed, so it gives the attempt back, waits for Resend's `retry-after` delay and ends the pass. The 23-hour window still counts from the first attempt.
- `sent` means the provider accepted the message, not that it reached the inbox. Failed invitations can be resent; failed test messages can be retried.

The mail port accepts a destination, subject, HTML and plain-text parts, a category tag and the message ID. Messages contain authorized issue or connection links and no provider payloads. Tests inject a deterministic provider through composition; there is no public test-mailbox endpoint. Queue tenant discovery and source triggers run as the migration owner, which needs RLS bypass; runtime connections stay restricted.

### Daily morning briefs

Daily briefs are an optional member preference, off by default and released through the
`operational-morning-brief` PostHog flag. Each member chooses a wall clock time in the
workspace timezone. API replicas check due schedules every minute and use one durable mail
receipt per member and local date; a repeated daylight-saving hour cannot duplicate a brief,
and a skipped hour sends at the next available time. Restarts catch up on the current day.

The brief composes the same authorized Needs you and operations readers as Home. Current
decisions and unresolved cases stay separate from independently verified outcomes. The
verification interval starts at the previous prepared brief's end, or the previous local
midnight for the first brief. This retains continuous reporting through timezone changes,
daylight saving and downtime. The frozen interval and content stay identical through retries;
empty complete reads retain a cancelled receipt without sending. Failed reads retry without
creating a receipt or inventing zeros.

Figures count verified cases, not action attempts or SKU quantities. Missing decision sources
remain labelled incomplete, and inaccessible issue figures are withheld. The Home link selects
the same explicit verification interval while current attention remains current; fixed-window
autonomy measurement is omitted for that variable interval. Specific decision and case links
retain their usual authorization checks.

Dispatch rechecks the release, membership, effective grants, preference and address suppression.
Changed grants cancel the snapshot rather than delivering previously authorized data. Opt-out
cancels queued briefs. A queued brief that reaches the next local date expires; it does not send
alongside the new day's brief. The usual provider idempotency and bounded retry rules apply.

### Language and content

Every message is rendered when it is sent, from the `@luma/email` templates and the `email` message catalog, so queued mail follows a language change. Mail uses the recipient's stored language:

- Picking a language in the web app reloads the page; the first signed-in page afterwards stores it on the account. Each browser remembers what it sent per account, so this happens once per change. Sign-in also stores the browser's picked language, or fills an empty one from the browser preference.
- An invitation uses the invitee's language when the address already has an account, otherwise the inviter's.
- Password mail uses the language of the browser that asked for it.
- People with no stored language get English.

Workspace mail names the workspace and shows times in the workspace time zone; account notices show dates in UTC. Text from people, such as the reason support gives, is rendered as text and never as markup.

### Templates and previews

Templates live in `packages/email`. They share one layout: wordmark, a card with the heading, one main action with its address written out for clients that block buttons, and a footer that says why the person received the message. Styles are inlined with the light theme's token values, because email clients don't read CSS variables; Apple Mail and Outlook for Mac switch to the dark theme through a media query. The plain-text part comes from the same document and drops the wordmark, preview text and button fallback.

Run `pnpm --filter @luma/email preview` to open the React Email preview server with every message in English and German. It reads the package's sample data, so add a sample and a preview file per language with each new message. The render tests send every sample through both languages.

### Delivery events

With `MAIL_RESEND_WEBHOOK_SECRET`, Resend reports delivery, delays, bounces and spam complaints to `POST /api/v1/email/resend/events`. Point a Resend webhook at that URL with the `email.delivered`, `email.delivery_delayed`, `email.bounced` and `email.complained` events and copy its signing secret.

- Requests without a valid signature for the secret return 401. Events count only for messages whose Resend ID this deployment recorded when sending, so environments can share a Resend account. Receipts hold no address or content and are removed after 30 days.
- A permanent bounce or a spam complaint pauses issue and connection notifications to the account with that address. Settings tells the person why. Invitations, test messages and account and security mail are still sent.
- A later delivered message to the address lifts the pause, so a delivered test message resumes notifications. Changing the account's address also lifts it. Pauses are erased with the account.

## Timezone

Timestamps are stored in UTC; the default display timezone is UTC. `WorkspaceDate` formats visible dates in the workspace's IANA timezone, and Activity and Shadow reporting use workspace day boundaries, including daylight-saving transitions.

## Provider writes

Only owners change workspace write mode. New workspaces default to observe-only; reads,
diagnosis and proposals keep running, while provider writes stop at execution admission.
Changing the mode uses the workspace revision and a command receipt and records the
previous and new mode. Connection overrides can only make this rule stricter. See
[execution controls](execution.md#observe-only).

## Approval preference

Always requiring approval adds a review to otherwise allowed low-risk changes. Turning it off restores risk-based review requirements. A separate preference controls whether an approver with `decisions.respond` must differ from the requester. It defaults on for teams and is automatically off while fewer than two active members have access; pending invitations, suspended memberships and disabled accounts do not count. The stored team preference applies again when another member gains access. Required reviews, capability restrictions, denials, verification and action admission stay mandatory.

Both preferences use the policy revision, command receipts and before/after audit evidence. The effective policy version also includes whether independent approval applies, so a membership change that toggles the rule invalidates earlier reviews and approval grants.

Changing either preference increments the policy revision, and decisions and approvals bind to that revision:

- Reviews made under an old revision lose their decision controls and show a refresh notice. Old approvals do not carry forward.
- Admission re-evaluates policy, the reservation fence checks the current revision, and dispatch checks it again after audit persistence.
- Rejected intent stays rejected across revisions.

## Personal layouts

Each member stores their own Home modules and sidebar pins per workspace; layouts are never shared. A `home` of `null` means the default Home. Saving replaces the whole layout at the revision last read, and a stale revision returns 409 so the client reloads. Each module appears at most once, pins are limited to 12, and a pin's path is relative to the workspace root, such as `exceptions?view=active`. Unknown module IDs from older layouts are dropped on read.

Theme and default sidebar width are device preferences stored in the browser, not in the layout.

## Luma support access

Support access lets Luma staff open read-only views of the workspace as a member; see
[staff access](staff.md#support-view). Allowing sets an end time 24, 72 or 168 hours from now and
replaces an earlier one; revoking clears it and ends open views on their next request. Approving
a request allows the requested duration from now, or keeps a later end time. Each is a command
with a receipt and a `revision`, recorded as a `support_access.*` access event. Staff can't change
consent from a support view, because every write is refused there.

## Bounded delegation

Scoped delegation governs only internal supplier follow-up notes. It does not lower purchasing, financial or provider capability risk floors. Membership grants, requester independence, workspace approval preferences and fresh verification still apply. New policies start in Manual; Assisted prepares review; Autonomous requires explicit promotion. Changing scope demotes Autonomous and invalidates decisions through the workspace policy epoch.

Exact quantity and optional exposure reservations share the execution transaction and tenant dispatch fence. Daily budgets use UTC and conservatively count every reserved attempt, including withheld work. A pause committed before reservation prevents new work. Existing attempts remain available for reconciliation. Failed verification, uncertain dispatch or unavailable verification pause the policy, lower its mode and persist an audit event.

Preview applies the current policy to at most 100 retained owner-read samples and labels live, synthetic and unknown provenance separately. Only current-scope live reviewed and verified history earns promotion: at least 20 samples, at least 95% acceptance and verification, and no retained failure or uncertain effect. A retained bare live label is insufficient: each earned sample needs its original reviewed source declaration and the current exact declaration and source binding. Synthetic runs do not establish production reliability.

The release gate defaults off and controls availability, never authority. Persisted enrollment remains governed after rollback and blocks new work while the gate is off. Never-enrolled workspaces retain ordinary internal-note behavior. Immutable native proposals pin the owner revision and exact supplier, destination, line, price and source inputs. The owner rechecks these in the note transaction. Explicit refresh binds a successor proposal and execution step, retaining original workflow and logical receipt, and requires a new decision. Previous consent never transfers. A saved human response wakes the original workflow as its original bound principal; notification only causes admission to reread the immutable current proposal. Lost wakes use the durable polling fallback. Reserved or uncertain attempts must reconcile before renewal.

Connection managers can declare live operational use only after a fresh authenticated purchase-order read and explicit confirmation with a reason. Reviews expire after five minutes and bind tenant, connection, provider target, credential version, connection version and app installation version. Immutable declaration command receipts retain the reviewer, revision, reason and source identity evidence without provider record payloads. This is a reviewed workspace declaration, never provider certification or a write grant.

A positive simulator manifest overrides any declaration. Missing or revoked declarations, unavailable grants or apps, and changed source or credential bindings classify new work as unknown. Declaration changes cannot rewrite an earlier proposal's facts. An existing native approval becomes stale when its original source proof changes; explicit refresh creates a successor and a new decision. Autonomous admission and promotion require earned history matching the current exact declaration, source and credential revisions. Replacing a declaration requires a new reviewed track record; old history remains auditable with its original classification.

Source inspection reads one authenticated purchase-order page. The provider's approved transport remains in force. A review has a total ten-second deadline, at most four transport requests, a one MiB response limit and a two MiB total payload limit. Cancellation aborts the read; oversized, incomplete, empty, expired or interrupted evidence cannot be retained as a usable review. Retained source reviews contain normalized observation identities, revisions and timestamps, not provider record payloads or a canonical commerce projection.
