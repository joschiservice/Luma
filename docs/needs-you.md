# Needs you decision queue

Needs you lists every decision that waits on a person, whichever owner raised it. It is a
read projection: each item points to the owner's authoritative decision, and responses go
through that owner's review. The queue never approves, rejects or runs anything.

Code: `@luma/read-models` (queue), `@luma/resolution` (assignments), owners for their
decisions.

## Sources

| Source (ID prefix)               | Owner and rule                                                                                                                                                                                             | Responses                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Cases (`case:`)                  | Exceptions: the inbox attention rules (approval, manual step, uncertainty), minus approvals whose current proposal already has a response                                                                  | Case desk review and decisions                                          |
| Replenishment (`replenishment:`) | Procurement: runs awaiting a decision whose proposal is bound, unexpired and unanswered, with the same `canRespond` rule as the run review                                                                 | The workflow run's replenishment decision                               |
| Supplier orders (`supplier:`)    | Procurement: order-progress attention (submission approvals, uncertain sends, facts to review, changed commitments, overdue confirmations and deliveries)                                                  | The purchase order's own review                                         |
| Message replies (`message:`)     | Messaging: open threads whose reply deadline passed or falls within 30 minutes, owned by the reader or unassigned                                                                                          | The thread: reply, change the deadline or close it                      |
| Reply sends (`message-send:`)    | Messaging: replies awaiting approval, approved replies for their requester, and sends not yet confirmed by a thread read                                                                                   | The thread: approve or reject, send, or check the reply                 |
| Apps (`<appId>:<kind>:`)         | `AppDefinition.decisions`. Shopify lists stock corrections and fulfillment recoveries awaiting approval, awaiting a run by their requester, or accepted/uncertain without a verified outcome (last 7 days) | The app's own commands through its `inventory` or `fulfillment` UI slot |

Owners present their decisions: why, consequences (what each response causes), the exact
change (source, record, location and quantities) and evidence validity. Unknown impact is
labeled `unknown`, never guessed.

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
impact is not ranked below low. Items then sort by deadline, request time and ID. Keyset
cursors bind the tenant, reader, view, filters and page size, and carry the first page's
evaluation time so expiring items do not move between pages. Provider rows are recomputed per
request; clients refresh from the first page and deduplicate by ID.

A provider that throws is reported in `sources` as `unavailable`. Its decisions are missing,
not resolved, and the rest of the queue still loads.

Human tasks appear only for their current assignee or fallback person or role. Their
review collects a published choice and required evidence, with an optional note. The task's
deadline changes responsibility without removing the open handoff. Responses remain input
and cannot authorize a later action.

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
stream's 30-second reconciliation. The web queue and the sidebar count refetch when an event
lists `decisions`, coalescing bursts over 500 ms and letting active reads finish, and poll
every 30 seconds as a fallback.

Reading the queue must not write to a `decisions` table unless state changes; otherwise each
read wakes the next one. Shopify claim settlement therefore updates only unsettled claims. An opened item that leaves the queue stays visible, labeled
as departed, so the outcome remains readable. Home's attention module and the sidebar count
read the same API.

## Adding a source

1. Keep the decision and its checks in the owner. Add a read that returns only decisions that
   need a person now, from persisted state, bounded in size.
2. Present each decision with a stable, prefixed ID, the reason, why, consequences, exact
   change, deadline and evidence validity. Say `unknown` for impact without an explicit rule.
3. Give it a `DecisionOwner` the web can mount, and add a case to the owner review if needed.
4. Add its tables to the metric notification triggers with the `decisions` topic.
5. Cover the reader-specific `response`, removal after a response on another surface, and
   tenant isolation in the decisions e2e suite or the owner's.
