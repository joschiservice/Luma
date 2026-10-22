# Returns workspace

Returns lists the returns a connected store shares, and refunds that no return settles, with
their stage, refund state, order and evidence. Returns and refunds are imported through
commerce sync into the Orders owner's projections. Store records are imported without changing their facts. Shopify creation and approval run
through governed case actions; receipt and refunds remain separate steps.
People record their own receipt, inspection and resolution decisions in
[return cases](#return-cases), which link to store records without changing them.

Code: `@luma/orders` (stage and money rules, `orders_returns`, return cases),
`@luma/read-models` (reads).

## Model

The `returns.read` capability returns two record kinds per order, `return` and `refund`. Both
are order children, like fulfillments. Their canonical identities are per connection and
source-local; a refund's `returnId` must belong to the same order. Return lines refer to
canonical order lines, or to none for items the source did not tie to an order line.
Free-text customer and decline notes are not read.

### Stages and money

Orders derives the stage and refund state once, in the projection transaction:

| Stage                             | Rule (open returns are checked top to bottom)                              | Group     |
| --------------------------------- | -------------------------------------------------------------------------- | --------- |
| `requested`                       | Source status is requested.                                                | `action`  |
| `refund_failed`                   | Refund payments failed and none succeeded or is pending.                   | `action`  |
| `refund_pending`                  | A refund payment is pending.                                               | `waiting` |
| `awaiting_items`                  | Fewer units received than requested (only when receipt is reported).       | `waiting` |
| `awaiting_refund`                 | Refunded units are fewer than requested, or none refunded when unreported. | `action`  |
| `ready_to_close`                  | Received and refunded, still open.                                         | `action`  |
| `closed`, `declined`, `cancelled` | The source status.                                                         | `done`    |
| `unknown`                         | The source reported a status Luma does not recognize.                      | `waiting` |

A refund without a current return of its source gets its own row: `refunded`,
`refund_pending`, `refund_failed` or `refund_recorded` (no payment at all).

Only successful payments count as money returned. `refund.refunded` sums successful payments,
`refund.pending` sums pending ones, and failed attempts are counted. A refund recorded without
payments is `recorded`, never refunded. Amounts in different currencies are not added; the
totals are then null. The source-reported refund total is evidence only. Receipt that the
source does not report stays null, and the UI says "not reported" rather than assuming the
step happened.

## Storage

Orders rebuilds an order's `orders_returns` rows in the same transaction as a return or refund
projection pointer, and keeps each row's order number current when the order changes. The list
reads plain, indexed columns, because row security prevents index use on JSON expressions (see
[commerce projections](commerce-projections.md)).

## Sync

The `returns` stream reads `returns.read`, which the Shopify app offers when the store granted
`read_orders` and `read_returns`. Its history import waits for the order history, like
fulfillments. The Shopify adapter pages orders with a cheap check for returns and refunds and
reads details only for orders that have them. Incremental reads filter orders by update time;
return and refund notifications schedule a read, and the daily full read catches changes that
did not update the order. Returns have no source update time, so later reads replace earlier
ones by observation time.

Shopify connections authorized before returns were available keep their old permissions and
are listed with a reconnect prompt. JTL-Wawi does not share returns.

## Reads

The list and detail each read one read-only snapshot. The list returns counts per view and
stage under the search, filters and conditions, plus every commerce connection with its returns
access and sync state, so the page can explain missing coverage. Its keyset cursor is bound to
the tenant, filters, conditions, grouping and sort. A refund ID that settles a return resolves
to that return.

Search also matches the name and email address of the order's customer, through the order
links of the customer's own connection, when the reader can read customers and the source
shares contact details. Without customer access the same text matches only return fields.

### Conditions and grouping

The list accepts conditions and groups from the Returns catalog in `@luma/api-contract`, with the
shared rules for values, dates, groups and cursors described for
[Orders](orders-workspace.md#conditions-and-grouping).

- Value, refunded and pending amounts compare only within their currency; a refund state
  without a single currency has no amounts and matches no amount condition.
- Partially received means some but not all requested units arrived. It is unknown when the
  source does not report receipt or the requested units, as for refunds without a return.
- Groups: stage in lifecycle order (the stage sort's order), refund state, kind, reason, source,
  and request date by day, week or month. A return counts in the group of each of its reasons.
  Groups sum values per currency.
- Group counts are `complete: false` while a source still imports its returns.

### List page

Search can match customer names and email addresses, so the page keeps search text in page
state only, as [Orders](orders-workspace.md#list-page) does: never in the URL, saved views,
remembered list state or browser storage. A link's `q` is adopted on load and removed with a
replace. Links from before views (`stage`, `connectionId`, and the `oldest` and `newest` sorts)
become conditions and the request-date sort.

A view without a sort uses its segment's: oldest request first for Needs action and Waiting,
newest first otherwise. The stage cards set one "Stage is" condition, and the page sends that
condition as the `stage` parameter, so stage counts, which follow the search and the other
conditions, keep counting the other stages. A card for a stage outside the current segment
opens All returns. The board groups by stage without a move affordance, because the stage
derives from the store's records.

## Return cases

A return case is Luma's record of one return: lines of one source's order with whole units,
a reason and a note, and people's decisions on them. Store facts stay in `orders_returns` and
the canonical snapshots; a case refers to one store return at most (`sourceReturnId`) and
never rewrites it. `returns.read` reads cases; `returns.manage` (Owner and Admin by default)
changes them.

### Counting units

Returnable units of an order line are the ordered units minus units the source cancelled
before fulfillment, minus units in the order's non-cancelled cases, minus units in store
returns that no open case works. Declined and cancelled store returns count nothing. A case
that works a store return counts its own lines, so that return is not counted a second time.
A case binds to the lines of one connection; linked orders keep separate lines per source,
so units are never compared across sources. Opening a case takes a per-order transaction
lock, which keeps concurrent cases from claiming the same units. One open case can work a
store return; a partial unique index enforces it.

### Decisions

Receipt records received units per line (at most the requested units); requested units that
did not arrive are missing. Inspection splits each line's received units into resellable and
damaged and requires a receipt. A proposal names a refund, exchange, store credit or rejection
and the units to restock per line, which can't exceed the resellable units; a rejection
restocks nothing. A proposal is never executed: refunds, restocking and exchanges are separate
governed actions. Recording an earlier step again replaces it and clears the later ones.

Every change names a command ID and the expected revision. An exact retry by the same actor
changes nothing; a reused ID with another request, or a stale revision, is a conflict. The
case row, an append-only history entry with the decision, its actor and evidence, and an
audit entry commit together. Evidence is a note and an http(s) link; files are not stored.
An assignee must be a current member who can manage returns. Cancelling refuses while a
creation request is approved, sending or uncertain, and ends one awaiting approval.

### Creating the return in the order's system

When the case's connection grants `returns.create` with `returns.options.read` and
`returns.created.read`, a person can request the return there. The request fixes the
warehouse, one return reason and the case lines with their mapped source IDs; a line without
exactly one source mapping blocks it. It follows the purchase-order submission path in
[supplier commitments](supplier-commitments.md#submission): Action Admission binds the exact
high-risk action, another person with `decisions.respond` and the app permission approves,
and Luma dispatches once as the requester. Observe-only records `not_executed`.

Success needs an independent, complete read through `returns.created.read` that finds exactly
one return for the case with the approved lines and units; more than one, or different lines,
fails the request and nothing is sent again. Orders stores every read that verification or the
creation audit cites, with the connection, source record, read time and completeness, so each
cited ID resolves to that read. A read that cannot be stored is not cited, and the outcome
stays unknown. The provider's acceptance is stored with the reads as the
[write receipt](execution.md#runtimes) execution cites; a lost response has no receipt. An uncertain dispatch only reconciles by
reading, through a manual check or the [background follow-up](#background-follow-up). One request
per case can be live or created. Approvals expire after 24 hours; an approved request that was
not sent by then shows as expired. Requests are not in Needs you yet; approvers open the case. JTL-Wawi and Shopify
create returns; see [JTL](jtl.md#returns) and [Shopify actions](shopify-actions.md#returns).

For Shopify, a case linked to a requested return approves that exact request instead of
creating a second return. It must cover all the request's lines and quantities. An open,
closed, declined or cancelled source return cannot be approved again. A new case's return
uses a machine case marker on every source return line. A fresh complete read must find
exactly one open return with that marker and the approved units; matching quantities alone
never establish identity. If Shopify loses or changes that marker, the write stays uncertain.
After verified creation, commerce sync binds the imported return to the case and advances
its revision, preventing double counting. This technical binding changes no receipt,
inspection or financial decision.

## Limits

Views, stages, request and activity order and paging use the `orders_returns` indexes and
stayed under 20 ms at 20,000 returns. Value, pending-refund and stage order sort every matching
return; value and pending refund order by currency, then amount, and returns without a value
come last in both directions. Search matches names, order numbers, reasons and source IDs as substrings, so it
scans the tenant's returns (about 150 ms at 20,000); much larger volumes need a maintained
search index like the order list's. Customer matches scan the tenant's customer profiles once
per search. Re-measure with
`LUMA_RETURN_BENCHMARK=<return count> pnpm test:performance returns`. The benchmark copies one return, so its detail reads are larger than for a
real order.

### Service review

The case service view combines audited operator decisions with source return events and refund
payments. It retains their origins and read times. Missing source transitions stay absent.
The customer summary confirms payment facts only while the return and every associated refund
read are at most 24 hours old and the connection has healthy, granted access. Pending and failed
payments remain separate from successful money returned. A proposal is not execution evidence.

Case search and Needs you use persisted tenant data, never provider reads. Customer links follow
explicit source order mappings and require both customer and returns access. Linked orders retain
case reachability. Needs you uses the case's audited assignment; assignment changes go through
the case's revision-checked command and never grant action or approval authority.

### Settling goods and money

Receipt, inspection and the proposal are separate from provider effects. A case refunds received
units, including damaged units; it never refunds missing units. Restock is limited to the proposed
resale quantity. Each line needs an explicit canonical SKU mapping to the Wawi item and a current
warehouse chosen from an independent source read. Aggregate inventory locations are not warehouses.

Each settlement freezes its provider quote, case facts, source identities and evidence. Refunds use
Shopify's suggested refund for the selected units, including its tax, discount and captured-payment
allocation. A high-risk Action Admission request requires independent approval and current app
permission. Approval lasts 24 hours. A stale case or remapped source blocks dispatch. Changing case
ownership preserves the approval; changing physical facts after dispatch is refused.

One sent request permanently holds its case/kind/line slot. Restart or retry uses the same execution
identity. An uncertain outcome is read again, never resent. Shopify uses native refund idempotency;
Wawi stock changes have no provider idempotency guarantee. An independent read must find the exact
operation marker, approved units and physical stock total. Concurrent unrelated movements leave the
stock step uncertain. Financial proof requires successful transactions for the whole approved amount
and currency. Pending, failed and partial payments never establish settlement. Quotes, proofs,
verification and the settlement audit cite only reads that orders stored, in the same
transaction, as for creation; a partial read never verifies a step. Settlement and exchange
write receipts are stored as for creation. Case completion still
requires the other steps; neither accepted mutation nor one verified step closes a case.

Creations, settlements and exchange steps show what they cite through the
[evidence reader](execution.md#reading-cited-evidence): the reads their quote, proof and
verification name and the write receipt, scoped to the case. Exchanges show the reads behind
their availability and completion check, and deadline waits the money reads or case revision
their last check found. Proofs recorded before orders stored
reads show those reads as not retained; money evidence that names a case revision resolves to the
return case. A case's Needs you item cites one of these records and names which one; see
[cited evidence in Needs you](needs-you.md).

An admission rejection alone does not release a send fence: another caller may already have reserved
the same execution. Only the durable execution ledger can establish non-dispatch. Concurrent late
results retain newer proof, and an exchange's processing fence resets in the same owner transaction
as confirmed non-dispatch. If admission has not reserved execution, the same sending identity remains
resumable; it is never replaced with another provider operation.

Settlement proof older than five minutes is shown as stale. Unavailable reads retain the last proof
and ask for another check. Wawi settlement writes are currently granted only in the installed
simulator. A live installation needs its stock write capability verified before it can be granted.

### Exchanges

A reviewed exchange credits only received units. The replacement needs explicit canonical SKU
mappings to Shopify's inventory item and Wawi's item. Shopify availability and Wawi's reported
all-warehouse availability are read independently; neither is a reservation. Luma first requests
an unprocessed native exchange, then asks separately for approval to process its exact lines and
native financial outcome. A source return without a compatible replacement intent needs an owned
handoff; Luma does not invent an API to add exchange lines to an existing return.

One case operation retains the replacement requests, approval steps and availability choices.
After processing could have been sent, its permanent slot prevents a second replacement fulfillment.
A lost response is reconciled through the exact machine marker and native processed lines, not by
sending another request. An independently read fulfillment can be prepared while its price difference
is still pending or failed. Charges require new successful captured transactions for the approved
amount and currency and a zero outstanding balance. Refund differences require successful native
return-refund transactions for the approved amount. Only the exact payment hold can be released,
through a separate approval after fresh payment proof; unrelated holds remain in place.

When stock changes, the case owner explicitly chooses wait, a different item or a refund. A different
item or refund first requires governed cancellation of the pristine source intent and independent
cancellation proof. A processed or uncertain processing attempt cannot be replaced this way. Refund
handoff preserves inspected resale stock quantities and still requires separate refund approval.
Wawi allocation remains owned work: native Shopify intent is not proof of an ERP reservation or
replacement order. Neither prepared fulfillment nor a paid difference alone closes the case.

### Background follow-up

Approval sends at once from the API, as the requester. If that send never starts, for example
because the API stopped after recording the approval, the commerce sync worker's return
follow-up sends the creation, settlement or exchange step as the requester, with the same
execution identity, while the approval is valid. It also stores an approval or rejection that
policy recorded but the case did not. The approver never gains execution authority.

- An unsent step whose approval ended is recorded as expired and frees its slot. A new request
  needs a new approval.
- A send fence without an execution reservation resumes under its approval. After the approval
  ends it is released as expired, because execution refuses to dispatch an expired approval.
- Reserved and uncertain steps are only read, never sent again: at most once a minute, and
  pending refund money every five minutes. Only fresh independent proof verifies them.
- Steps changed in the last two minutes are left to the request sending them.
- Sending and reading need the requester's current `returns.manage` permission. Without it the
  step waits and then expires. Suspended, disabled and erased requesters are skipped.

## Owned return deadlines

Merchant deadline configuration is versioned and disabled until reviewed. Receipt waits start
at case opening; inspection waits start at the recorded receipt; proposal waits start at
inspection. Financial waits start at the proposal, then the actual action request once one
exists. Missing physical units can wait alongside inspection of the units that arrived.
Unobserved store transitions never supply an inferred timestamp.

The return step follow-up must be activated in Workflows for automatic monitoring. Its bounded
passes use a persisted cursor and reread each case no more than once per minute. Explicit progress checks use the same service and make no
provider writes. Reading sent money also reconciles an uncertain refund or exchange processing
attempt; it never sends one again. Each phase has one live occurrence; repeated observations update it rather
than opening duplicate cases. Policy or anchor changes supersede earlier occurrences. Disabled
policies and cancelled cases pause their waits without claiming verification.

Pending, failed and partial money remain unresolved. Only complete independent evidence no more
than five minutes old can verify financial progress; money proof from a partial read, or from a
proof recorded before its reads were stored, is incomplete. Unavailable access, missing evidence and
stale observations remain separate waiting reasons. Later recurrence creates a new occurrence
and preserves the earlier verified or escalated history. Case assignment controls ownership;
the workflow hands overdue steps to that owner rather than duplicating the Needs you item.

The existing imported-return refund follow-up requires a reported receipt timestamp. Latest
activity is not a substitute. A pending or failed stage never ends that follow-up; complete,
fresh evidence of the refunded units and settled money is required.
Record read times establish freshness independently of the daily full-scan timestamp. The full scan
establishes coverage, rather than making a current incremental payment read stale. Bounded passes
retain a tenant-scoped cursor per view, advance past settled or unreceived returns, and resume after
restart. A failed detail read retains the page for another pass.

### Independent exchange completion

The final check reads the configured Shopify and Wawi installations again. It compares source receipt
and stock disposition with the case, the exact approved Wawi restock movement and warehouse total,
the native processed replacement price, and actual payment or refund transactions. In Wawi, an
operator creates one paid replacement sales order with the operation reference shown in the case.
The read checks the exact mapped item, quantity and gross total, plus native reservations tied to
that sales order. Reported item availability is never used as proof of reservation.

Order and reservation scans stop at 500 records, with complete pagination required to prove uniqueness.
Missing access, incomplete scans, duplicate references, unsettled money, price disagreement and
concurrent stock movements leave the case open with its current owner and a specific handover in
Needs you. Each verdict cites only source reads that orders stored with it, in the audit log
and on the exchange; a partial read establishes no check. Exchange quotes, proofs and the
availability an exchange records are stored the same way. Damaged units remain
unresolved because this pair cannot independently prove disposal in the physical stock owner.

Only a complete fresh verdict closes the case and retires its active return waits. A later explicit
check reads both sources again; if they no longer agree, it reopens the case, preserves its owner and
adds a history event. Past verification is a point-in-time result. The final check dispatches no
provider write and never replays uncertain exchange or stock actions.
