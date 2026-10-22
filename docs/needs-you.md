# Needs you decision queue

Needs you lists decisions the reader can act on now, whichever owner raised them.
Read-only decisions, approvals waiting on someone else and automatic execution belong in
the collapsible Waiting on others section. Its items do not enter Home or sidebar counts. It is a
read projection: each item points to the owner's authoritative decision, and responses go
through that owner's review. The queue never approves, rejects or runs anything.

Code: `@luma/read-models` (queue), `@luma/resolution` (assignments), owners for their
decisions.

## Sources

| Source (ID prefix)               | Owner and rule                                                                                                                                                                                                                   | Responses                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Cases (`case:`)                  | Exceptions: the inbox attention rules (approval, manual step, uncertainty), minus approvals whose current proposal already has a response                                                                                        | Case desk review and decisions                                                            |
| Replenishment (`replenishment:`) | Procurement: runs awaiting a decision whose proposal is bound, unexpired and unanswered, with the same `canRespond` rule as the run review                                                                                       | The workflow run's replenishment decision                                                 |
| Supplier orders (`supplier:`)    | Procurement: order-progress attention (submission approvals, uncertain sends, facts to review, changed commitments, overdue confirmations and deliveries)                                                                        | The purchase order's own review                                                           |
| Message replies (`message:`)     | Messaging: open threads whose reply deadline passed or falls within 30 minutes, owned by the reader or unassigned                                                                                                                | The thread: reply, change the deadline or close it                                        |
| Reply sends (`message-send:`)    | Messaging: replies awaiting approval, approved replies for their requester, and sends not yet confirmed by a thread read                                                                                                         | The thread: approve or reject, send, or check the reply                                   |
| Apps (`<appId>:<kind>:`)         | `AppDefinition.decisions`. Shopify lists stock corrections, fulfillment recoveries and order quantity edits awaiting approval, awaiting a run by their requester, or accepted/uncertain without a verified outcome (last 7 days) | The app's own commands through its `inventory`, `fulfillment` or `record` (order) UI slot |

Owners present their decisions: why, consequences (what each response causes), the exact
change (source, record, location and quantities) and evidence validity. Unknown impact is
labeled `unknown`, never guessed.

A decision that cites stored evidence names its subject for the
[evidence reader](execution.md#reading-cited-evidence) in `citedEvidence`, with the references it
relies on when they are only part of what the subject cites: a purchasing plan, a replenishment
run, a native stock receipt review, a purchase order with a revision's or supplier item's
references, a reply, a case, or an app decision by its proposal. A return case item cites the
record behind what it asks for, in this order: a creation waiting on a person, an unresolved
exchange completion check, the deadline wait that is due, the latest refund, restock or exchange
step, then the last creation. Because that record could be any of these, the item names it in
`covers` (`return_creation`, `exchange_check`, `deadline_wait`, `refund_step`, `restock_step` or
`exchange_step`), and the disclosure is labeled with it, such as "Evidence: refund step".
Decisions that can cite only their own record keep the generic "What this decision cites". The
decision view shows it as a disclosure that reads the evidence only when opened, hidden when the
reader's role can't read the subject's area; the evidence reader checks access again. Decisions
without stored evidence show none.

Decision sources read persisted state only; they must not call external providers or models. A Shopify
preview can therefore be listed as approvable and still be refused when its review reads
Shopify and finds a changed revision. The app host lists an app's decisions only for
installed apps and filters each kind by the permissions its manifest declares; people
without the respond permission see the decision as view only.

## Ranking and paging

The queue asks each provider for the refreshed reader, then runs one repeatable-read query
(4-second statement timeout) that unions the case rows with the provider rows, joins
assignments and resolves source record identities through tenant mappings.

Rank 0 is a deadline within 30 minutes, rank 1 is high impact, rank 2 is the rest. Unknown
impact is not ranked below low. Items then sort by deadline, request time and ID. Provider
rows are recomputed per request; clients refresh from the first page and deduplicate by ID.

The queue holds only work waiting on a person, and owners present their decisions in memory
before ranking, so the query returns the whole view and the queue applies conditions, search,
sorting, grouping and paging to the presented items. Conditions use the decisions catalog:
owner (`me` resolves to each reader, empty is unassigned), area, reason, impact, deadline and
request time. Search matches titles. Sorts are urgency (the default), deadline and waiting
since; decisions without a deadline come last in both directions. Groups are area, reason,
owner and cause (the owner's `group` key); a group is incomplete while an owner is
unavailable. The older `domain` and `reason` parameters still work.

Actionability is evaluated before counts, filtering, grouping and paging. Direct decision
links can still open waiting items. View, area and reason counts follow the view and the older parameters only, never conditions
or search, so Home's attention module and the sidebar count keep matching the queue. Keyset
cursors bind the tenant, reader, view, conditions, search, sort and page size (or the group
key within a group), and carry the first page's evaluation time so expiring items do not move
between pages.

A provider that throws is reported in `sources` as `unavailable`. Its decisions are missing,
not resolved, and the rest of the queue still loads.

Human tasks appear only for their current assignee or fallback person or role. Their
review collects a published choice and required evidence, with an optional note. The task's
deadline changes responsibility without removing the open handoff. Responses remain input
and cannot authorize a later action. A task about an order links to it, where the order's
change plan shows what the task asks for.

## Assignment

`decision_assignments` stores the current owner per decision ID with an optimistic revision;
Resolution owns the writes. `decisions.self_assign` takes an unassigned decision or releases
one's own; `decisions.assign` assigns any decision to a current member. The decision must
currently be in the reader's queue. Assignment never grants approval authority. Case responsibility comes from the case owner;
its optimistic assignment and audit are owned by Exceptions. Human task responsibility is
published with the workflow and refreshed against the current membership.

Return cases contribute receipt, inspection and settlement work under returns access. Their
creation approvals retain independent approval and requester execution rules. The owning case's
audited assignment is authoritative, and generic queue assignment commands cannot replace it.
The source returns unavailable rather than silently dropping cases when its bounded read limit
is exceeded. Source payment acceptance and a recorded proposal never count as completion.

## Live refresh

Every table the queue reads for its items carries the `decisions` topic on the shared
[workspace change stream](operational-metrics.md#live-delivery): case, proposal and policy
tables, admission steps, workflow process steps, replenishment activations, purchase orders,
supplier submissions, commitments and follow-ups, executed actions, the Shopify recovery and
claim tables, message threads, document facts and replies, and assignments. Record links and handover signals from orders refresh with the
stream's 30-second reconciliation. The workspace shell holds one subscription for the queue,
Home's attention module and the sidebar count. They refetch when an event lists `decisions`,
coalescing bursts over 500 ms and letting active reads finish. While the stream is live they do
not poll, refetch on focus or refetch when a screen mounts. While it connects or is interrupted
they poll every 30 seconds. The sidebar and Home share one read, so opening Home doesn't build
the queue again.

Each read builds the whole queue, so its cost must not grow with the number of decisions an
owner lists. Owners read their decisions and the policy decisions behind them in bulk. Nested
owner checks reuse the request's refreshed membership (see
[identity](identity.md#context-and-isolation)). A statement budget journey holds this for 200
return cases.

The web queue tracks the focused and open decision by ID, so a refresh that reorders the queue
leaves the reader where they were. Saved views keep conditions, sort, grouping and properties;
search text stays in page state. Older links with an area, a reason or the cause switch open
the same conditions and grouping.

Reading the queue must not write to a `decisions` table unless state changes; otherwise each
read wakes the next one. Shopify claim settlement therefore updates only unsettled claims. An opened item that leaves the queue stays visible, labeled
as departed, so the outcome remains readable. Replenishment, stock correction, supplier-send and issue approval links also read persisted responses after they leave the queue, including the deciding person, time, execution outcome and record or run links. These historical views grant no response authority. Home's attention module and the sidebar count
read the same API.

## Adding a source

Follow the [add-needs-you-source](../.agents/skills/add-needs-you-source/SKILL.md) skill. Keep
the decision and its checks in the owner, read persisted state only, and cover tenant
isolation and removal after a response on another surface.
