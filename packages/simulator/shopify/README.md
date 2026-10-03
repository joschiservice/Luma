# @luma/simulator-shopify

Simulates one Shopify store's Admin GraphQL API 2026-07 for Luma's real Shopify adapter. Provider records live in the host's `RecordStore`; the package owns the protocol, the merchant commands and their webhooks.

## Responsibilities

- Serves the GraphQL surface Luma uses with `graphql-js` and the adapter's schema file, so selections, aliases, fragments, variables and validation errors behave as on Shopify. [admin-2026-07.graphql](./admin-2026-07.graphql) must stay identical to the adapter fixture; `tooling/simulator/shopify-contract.test.mjs` checks this.
- Applies Shopify's lifecycle rules in commands: committed stock, fulfillment orders and holds, partial fulfillment, shipment tracking, cancellation, returns, refunds and product changes. Each change bumps the affected records and their order or product, and reports the webhook Shopify would send through `context.notify`.
- Keeps canonical Luma models and cross-provider orchestration out of the provider. Import only `@luma/simulator-core` and npm packages.

## Public entry points

Import through `@luma/simulator-shopify` ([source](./src/index.ts)):

- `shopify` — the `ProviderSimulator`: `handle`, `identify`, `command`, `unauthorized`, `drift` and `rateLimit`.
- `rateLimit` — Shopify's 2,000 point bucket restored at 100 points per second. Requests are admitted by requested cost; `rateLimit.actualCost(response)` returns the cost Shopify deducts, so hosts can refund the difference.
- `readOrder`, `readStock` — merchant-engine views of an order and of an item's stock at a location.
- `readSubscriptions`, `subscriptionTopic` — webhook subscriptions created through the API, matched to notification topics.
- Command, configuration and result types, and `shopifyHoldReasons`.

## Behavior to know

- Records use Shopify type names as store kinds and numeric IDs. Allocated IDs come from one shop-wide sequence; variants and inventory items share an ID. Inventory levels use Shopify's `InventoryLevel/<location>?inventory_item_id=<item>` IDs.
- Connections answer `first`/`after`, `last`/`before`, `reverse` and `sortKey: UPDATED_AT` with store keyset cursors. Queries with a `query` search hide records changed within `context.indexLagMs`.
- Without `read_all_orders` in the configured scopes, orders older than 60 days are hidden.
- `inventorySetQuantities` requires `@idempotent(key:)`, compares `changeFromQuantity` exactly and stores successful receipts in the record store. A replay returns the stored receipt; another input with the same key is refused.
- `fulfillmentOrderMove` moves whole fulfillment orders only. Partly fulfilled work splits into a new fulfillment order at the target location.
- Catalog seeding writes in one bulk insert and sends no webhooks.

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/simulator-shopify...
pnpm exec turbo run typecheck --filter=@luma/simulator-shopify
pnpm exec turbo run test --filter=@luma/simulator-shopify
pnpm exec turbo run build --filter=@luma/api... --filter=@luma/simulator-shopify... && node --test tooling/simulator/shopify-contract.test.mjs
```

## Further reading

- [Engineering guide](../../../docs/simulator.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
