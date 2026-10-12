# @luma/simulator-jtl

Simulates a JTL-Wawi ERP behind the ERP REST API 2.2 that Luma's JTL adapter uses: sales orders, items with warehouse stock, delivery notes, shipping methods, suppliers, purchase orders and returns.

The package implements `ProviderSimulator` from simulator-core. The host owns transport, persistence, failure injection, rate-limit buckets and scheduling; this package owns JTL records, the HTTP surface and merchant, warehouse and supplier commands. Records live in the context's `RecordStore`, scoped to one ERP instance; the host table is `sim_jtl_records`. Canonical Luma models and cross-provider scenarios belong outside this package. Exports point to compiled `dist` output.

## Model

- **Items** hold physical stock per configured warehouse and the open quantity of uncancelled sales orders. `stockTotal` is the sum over warehouses, `stockReservedTotal` the reservation and `stockAvailable` their difference; it is negative when orders oversell. Every stock change advances `modifiedTimestamp` strictly.
- **Sales orders** are numbered `AU-` plus the zero-padded order ID, including fixtures with explicit IDs. An order reserves its quantities. `deliveryStatus` is 1 (open), 3 (partially shipped) or 5 (shipped); cancelled orders keep their delivery status and set `isCancelled`. `paymentStatus` is 2 (paid) or 0 (pending). `shippingDetails.shippingDate` is the first shipment's date.
- **`ship`** books one delivery note with one package for the given line quantities, or every open unit, from one warehouse. Physical stock there and the reservation decrease. It refuses quantities above the open quantity and shipments the warehouse cannot cover. Orders may have several delivery notes. With `packing: true` the package has no shipping date yet, as while a parcel is being packed: Luma reads the note as fulfilment in progress, not shipped.
- **`cancel`** releases reservations and is refused once any unit has shipped. Shipping-method changes, through the command or `PATCH`, refuse cancelled orders and unknown methods and offer no compare-and-swap or idempotency.
- **Purchase orders** use statuses 0, 5, 20, 30, 50 and 500. Lines are numbered order ID × 1,000 plus position. Creation time is the later of simulation and wall-clock time. A `POST` with a known `Idempotency-Key` returns the recorded order. Goods receipts add stock to the order's warehouse (the first configured warehouse) unless the command names another.
- **Returns** belong to the single company `1` that every sales order reports. A `POST` must name lines of an uncancelled order, a configured warehouse and configured return reasons (`returnReasons`, by default Defective, Wrong item and No longer wanted); a line's returned units across all returns cannot exceed its ordered quantity. Returns are numbered `RE-` plus the zero-padded return ID, keep `externalNumber` as created and list per order with `salesOrderId`. A `POST` with a known `Idempotency-Key` returns the recorded return.
- **Suppliers** carry a profile that plans confirmations and receipts for orders placed afterwards (`supplierEvents`).
- **`seed-catalog`** inserts items, warehouse stock, suppliers and assignments in one `putMany`; items and suppliers must be new.

Lists page by `pageNumber` and `pageSize` (at most 1,000) in creation order. `totalItems` is the current count, so records created while a client pages shift later pages.

## Host integration

- Schedule `supplierEvents` from the merchant `purchase-order` command result, and from the `purchase-orders/create` event payload for orders created through the API.
- Other events (`sales-orders/create`, `sales-orders/update`, `delivery-notes/create`, `items/stock`, `items/seed`, `purchase-orders/update`, `returns/create`) are for the journal; JTL sends no webhooks.
- `readOrder`, `openOrders`, `readItemStock` and `itemsPage` serve the merchant engine. Open orders carry the store key `open`, so they can be queried without scanning all orders.
- Refusals throw `JtlError`; its `status` is the HTTP answer for the same condition.

## Validation

`pnpm test:simulator` builds the adapters and runs the contract tests in `tooling/simulator`, which drive the real JTL connector against this package.

## Further reading

- [Simulator](../../../docs/simulator.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
