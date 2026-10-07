# Returns workspace

Returns lists the returns a connected store shares, and refunds that no return settles, with
their stage, refund state, order and evidence. Returns and refunds are imported through
commerce sync into the Orders owner's projections. The workspace only reads: approving,
receiving and refunding happen in the store, and Luma reads the result on its next sync.

Code: `@luma/orders` (stage and money rules, `orders_returns`), `@luma/read-models` (reads).

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

## Limits

Views, stages, sorting and paging use the `orders_returns` indexes and stayed under 20 ms at
20,000 returns. Search matches names, order numbers, reasons and source IDs as substrings, so it
scans the tenant's returns (about 150 ms at 20,000); much larger volumes need a maintained
search index like the order list's. Re-measure with `LUMA_RETURN_BENCHMARK=<return count>` on
`returns.e2e.mjs`. The benchmark copies one return, so its detail reads are larger than for a
real order.
