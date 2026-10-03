# @luma/simulator-jtl

Simulates a JTL-Wawi ERP behind the ERP REST API 2.2 that Luma's JTL adapter uses: sales orders, items with warehouse stock, delivery notes, shipping methods, suppliers and purchase orders.

## Responsibilities

The package implements `ProviderSimulator` from simulator-core. The host owns transport, persistence, failure injection, rate-limit buckets and scheduling; this package owns JTL records, the HTTP surface and merchant, warehouse and supplier commands. Records live in the context's `RecordStore`, scoped to one ERP instance; the host table is `sim_jtl_records`. Canonical Luma models and cross-provider scenarios belong outside this package.

## Model

- **Items** hold physical stock per configured warehouse and the open quantity of uncancelled sales orders. `stockTotal` is the sum over warehouses, `stockReservedTotal` the reservation and `stockAvailable` their difference; it is negative when orders oversell. Every stock change advances `modifiedTimestamp` strictly.
- **Sales orders** are numbered `AU-` plus the zero-padded order ID, including fixtures with explicit IDs. An order reserves its quantities. `deliveryStatus` is 1 (open), 3 (partially shipped) or 5 (shipped); cancelled orders keep their delivery status and set `isCancelled`. `paymentStatus` is 2 (paid) or 0 (pending). `shippingDetails.shippingDate` is the first shipment's date.
- **`ship`** books one delivery note with one package for the given line quantities, or every open unit, from one warehouse. Physical stock there and the reservation decrease. It refuses quantities above the open quantity and shipments the warehouse cannot cover. Orders may have several delivery notes.
- **`cancel`** releases reservations and is refused once any unit has shipped. Shipping-method changes, through the command or `PATCH`, refuse cancelled orders and unknown methods and offer no compare-and-swap or idempotency.
- **Purchase orders** use statuses 0, 5, 20, 30, 50 and 500. Lines are numbered order ID × 1,000 plus position. Creation time is the later of simulation and wall-clock time. A `POST` with a known `Idempotency-Key` returns the recorded order. Goods receipts add stock to the order's warehouse (the first configured warehouse) unless the command names another.
- **Suppliers** carry a profile that plans confirmations and receipts for orders placed afterwards (`supplierEvents`).
- **`seed-catalog`** inserts items, warehouse stock, suppliers and assignments in one `putMany`; items and suppliers must be new.

Lists page by `pageNumber` and `pageSize` (at most 1,000) in creation order. `totalItems` is the current count, so records created while a client pages shift later pages.

## Host integration

- Schedule `supplierEvents` from the merchant `purchase-order` command result, and from the `purchase-orders/create` event payload for orders created through the API.
- Other events (`sales-orders/create`, `sales-orders/update`, `delivery-notes/create`, `items/stock`, `items/seed`, `purchase-orders/update`) are for the journal; JTL sends no webhooks.
- `readOrder`, `openOrders`, `readItemStock` and `itemsPage` serve the merchant engine. Open orders carry the store key `open`, so they can be queried without scanning all orders.
- Refusals throw `JtlError`; its `status` is the HTTP answer for the same condition.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/simulator-jtl` — [source](./src/index.ts).

## Workspace dependencies

[@luma/simulator-core](../core/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/simulator-jtl...
pnpm exec turbo run typecheck --filter=@luma/simulator-jtl
pnpm exec turbo run test --filter=@luma/simulator-jtl
node --test tooling/simulator/jtl-contract.test.mjs
```

The contract test drives the real JTL connector against this package; build `@luma/app-jtl` and its dependencies first.

## Further reading

- [Engineering guide](../../../docs/simulator.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
