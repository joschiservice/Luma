# Returns workspace

Returns lists the returns a connected store shares, and refunds that no return settles, with
their stage, refund state, order and evidence. Returns and refunds are imported through
commerce sync into the Orders owner's projections. Store records are only read: approving,
receiving and refunding happen in the store, and Luma reads the result on its next sync.
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
stage plus every commerce connection with its returns access and sync state, so the page can
explain missing coverage. Its keyset cursor is bound to the filters. A refund ID that settles a
return resolves to that return.

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

Success needs an independent read through `returns.created.read` that finds exactly one
return for the case with the approved lines and units; more than one, or different lines,
fails the request and nothing is sent again. An uncertain dispatch only reconciles by
reading. One request per case can be live or created. Approval requests expire after 24
hours. Requests are not in Needs you yet; approvers open the case. JTL-Wawi is the only
provider that creates returns; see [JTL](jtl.md#returns).

## Limits

Views, stages, sorting and paging use the `orders_returns` indexes and stayed under 20 ms at
20,000 returns. Search matches names, order numbers, reasons and source IDs as substrings, so it
scans the tenant's returns (about 150 ms at 20,000); much larger volumes need a maintained
search index like the order list's. Re-measure with `LUMA_RETURN_BENCHMARK=<return count>` on
`returns.e2e.mjs`. The benchmark copies one return, so its detail reads are larger than for a
real order.
