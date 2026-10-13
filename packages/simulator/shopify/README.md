# @luma/simulator-shopify

Simulates one Shopify store's Admin GraphQL API 2026-07 for Luma's real Shopify adapter. Provider records live in the host's `RecordStore`; the package owns the protocol, the merchant commands and their webhooks. Exports point to compiled `dist` output.

- Serves the GraphQL surface Luma uses with `graphql-js` and the adapter's schema file, so selections, aliases, fragments, variables and validation errors behave as on Shopify. [admin-2026-07.graphql](./admin-2026-07.graphql) must stay identical to the `@luma/app-shopify` fixture; the contract tests check this.
- Applies Shopify's lifecycle rules in commands: committed stock, fulfillment orders and holds, partial fulfillment, shipment tracking, cancellation, returns, refunds and product changes. Each change bumps the affected records and their order or product, and reports the webhook Shopify would send through `context.notify`.
- Keeps canonical Luma models and cross-provider orchestration out of the provider. Import only `@luma/simulator-core` and npm packages.

## Behavior to know

- Records use Shopify type names as store kinds and numeric IDs. Allocated IDs come from one shop-wide sequence; variants and inventory items share an ID. Inventory levels use Shopify's `InventoryLevel/<location>?inventory_item_id=<item>` IDs.
- Connections answer `first`/`after`, `last`/`before`, `reverse` and `sortKey: UPDATED_AT` with store keyset cursors. Queries with a `query` search hide records changed within `context.indexLagMs`.
- Without `read_all_orders` in the configured scopes, orders older than 60 days are hidden.
- `inventorySetQuantities` requires `@idempotent(key:)`, compares `changeFromQuantity` exactly and stores successful receipts in the record store. A replay returns the stored receipt; another input with the same key is refused.
- `fulfillmentOrderMove` moves whole fulfillment orders only. Partly fulfilled work splits into a new fulfillment order at the target location.
- Order line prices are the prices after the order's discounts; a discount derives each line's original price from its percentage, so discounts never change the total. A shipping price adds to the total. Orders have one shipping line (free unless priced), tax lines from the shop's rate, the customer's address as delivery and billing address, and optionally a presentment currency whose amounts are the shop amounts at a fixed rate. Refunds and transactions stay in the shop currency.
- Order edits run as Shopify's calculated-order flow and require `write_order_edits`. `orderEditBegin` stores an `OrderEditSession`; `orderEditSetQuantity` stages a line's new current quantity on it. Neither changes the order nor sends webhooks. Calculated line IDs reuse the `LineItem` number.
- `orderEditCommit` checks every staged change again against the current records and refuses the whole edit when the order is cancelled or closed, a line's quantity changed since staging or removed units were fulfilled meanwhile. A session commits once. Only the commit marks the request committed, so response loss on `orders.quantity.edit` happens after the change.
- Edits remove only units still remaining in open fulfillment work and release their committed stock. Added units grow the line's first open fulfillment order line and commit stock at its location; a line without open work cannot grow. The order total changes by the edited units at the line price.
- Every edit records an `OrderEditAgreement` with one `ProductSale` per changed line: `RETURN` with negative quantity for removed units, `ORDER` with positive quantity for added units. API commits name the simulator app (`currentAppInstallation.app`); merchant `order-edit` commands have no app. `Order.agreements` filters by `happened_at:>=` and `happened_at:>` and ignores other search terms.
- `LineItem.unfulfilledQuantity` is the line's remaining quantity in open fulfillment orders (`OPEN`, `IN_PROGRESS`, `SCHEDULED`, `ON_HOLD`).
- Catalog seeding writes in one bulk insert and sends no webhooks.
- `rateLimit` is Shopify's 2,000-point bucket restored at 100 points per second. Requests are admitted by requested cost; `rateLimit.actualCost(response)` returns the cost Shopify deducts, so hosts can refund the difference.

## Validation

`pnpm test:simulator` builds the adapters and runs the contract tests in `tooling/simulator`, which drive Luma's real Shopify adapter against this package.

## Further reading

- [Simulator](../../../docs/simulator.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
