# Returns workspace

Returns lists the returns a connected store shares, and refunds that no return settles, with
their stage, refund state, order and evidence. Returns and refunds are imported through
commerce sync into the orders owner's projections. The workspace only reads: approving,
receiving and refunding happen in the store, and Luma reads the result on its next sync.

## Model

`returns.read` returns two record kinds per order: `return` and `refund` observations
(`ReturnSnapshot`, `RefundSnapshot` in `packages/connections/src/domain/capabilities.ts`).
Both are order children in `@luma/orders`, like fulfillments. Their canonical identities
are per connection and source-local; a refund's `returnId` must belong to the same order.
Return lines refer to canonical order lines, or to none for items the source did not tie to
an order line. Free-text customer and decline notes are not read.

A return carries its status, request, approval, receipt and close times and, per line, the
requested units, reason label, units received and restocked, units the source reports as
refunded and the value of the returned units. A refund carries its source total, lines with
restock type, and every payment attempt with status `success`, `pending`, `failed` or
`unknown`.

### Stages and money

`packages/orders/src/domain/returns.ts` derives the stage and refund state once, in the
projection transaction:

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

Only successful payments count as money returned. `refund.refunded` sums successful
payments, `refund.pending` sums pending ones, and failed attempts are counted. A refund
recorded without payments is `recorded`, never refunded. Amounts in different currencies
are not added; the totals are then null. The source-reported refund total is shown as
evidence only. Receipt that the source does not report stays null, and the UI says
"not reported" rather than assuming the step happened.

## Storage

Migration `0044_returns_refunds.sql` allows the `return` and `refund` kinds, mappings and
statuses, the `returns.read` read check and the `returns` sync record type, and adds
`orders_returns`. The orders owner rebuilds an order's rows in that table in the same
transaction as a return or refund projection pointer, and keeps each row's order number
current when the order changes. The list reads plain, indexed columns, because row
security prevents index use on JSON expressions (see
[commerce projections](commerce-projections.md)).

## Sync

The `returns` stream reads `returns.read`, which the Shopify app offers when the store
granted `read_orders` and `read_returns`. Its history import waits for the order history,
like fulfillments. The Shopify adapter pages orders with a cheap check for returns and
refunds and reads details only for orders that have them. Incremental reads filter orders
by update time; returns and refund notifications schedule a read, and the daily full read
catches changes that did not update the order. Returns have no source update time, so
later reads replace earlier ones by observation time.

Shopify connections authorized before returns were available keep their old permissions.
The Returns page lists them with a reconnect prompt. JTL-Wawi does not share returns.

## Read model and API

`createReturnWorkspace` in `packages/read-models/src/infrastructure/returns` implements the
list and detail in one read-only snapshot. The list filters by view (stage group), stage,
source and search, sorts by request or last source activity with a keyset cursor bound to
the filters, and returns counts per view and stage plus every commerce connection with its
returns access and sync state. The detail adds order lines with titles and SKUs, every
refund with its payment attempts, the order, other returns of the order and up to 50
observed snapshots. A refund ID that settles a return resolves to that return. The order
detail lists the order's returns and refunds.

Routes are `GET /v1/organizations/:organizationId/returns` and `/returns/:returnId`
(`packages/api-contract/src/contracts/returns.ts`).

## Web

`apps/web/src/features/returns` holds the list (`page.tsx`), detail (`detail.tsx`), the
order section (`order-returns.tsx`), URL state (`data.ts`) and wording and step rules
(`presentation.ts`). The list opens on **Needs action**, oldest request first, with a card
per pending stage. The detail states the next step and who owns it, shows progress from
request to close with source times, the items, refunds and money, the order and the
store's live order context through the app `record` slot. Returns is in the sidebar
(`G`, then `T`), and the optional **Returns** Home module shows the pending stages.

## Measurements

`apps/api/e2e/returns.e2e.mjs` includes a benchmark. Set `LUMA_RETURN_BENCHMARK` to a
return count; it writes the fastest of three API requests per read to
`/tmp/luma103-returns-<count>.json`. Measured on PostgreSQL 17 in Docker on a development
laptop:

| Read (ms)                  | 5,000 returns | 20,000 returns |
| -------------------------- | ------------: | -------------: |
| Needs action, oldest first |             7 |             15 |
| All, newest first          |             7 |             16 |
| Stage filter               |             7 |             15 |
| Search by order number     |            38 |            144 |
| Deep page                  |             8 |             12 |
| Detail                     |            27 |             85 |

Views, stages, sorting and paging use the `orders_returns` indexes. Search matches names,
order numbers, reasons and source IDs as substrings, so it scans the tenant's returns; a
maintained search index like `orders_search_values` is the next step for much larger
volumes. The benchmark copies one return, so every copy belongs to the same order and the
detail read's related-record lookups are larger than for a real order.

## Validation

```sh
pnpm --filter @luma/orders test
pnpm --filter @luma/app-shopify test
pnpm --filter @luma/simulator-shopify test
pnpm --filter @luma/web exec vitest run src/features/returns
pnpm --filter @luma/ui exec vitest run ../../apps/web/src/features/returns/returns.stories.tsx
pnpm test:e2e returns.e2e.mjs
pnpm test:browser returns.browser.mjs
```
