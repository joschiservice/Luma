# @luma/simulator-cin7

Simulates a Cin7 Core account behind the API v2 reads that Luma's Cin7 adapter uses: sales with fulfilments, credit notes, products, the stock report, locations, customers, suppliers and purchases.

`createCin7Simulator` serves an ERP model the host supplies (`ErpModel`): where records of each kind are stored and how merchant, warehouse and supplier commands change them. The simulator host supplies the JTL-Wawi model, so a merchant behaves the same with either ERP; it checks at compile time that the model stores every field this package reads (`Erp*` types). Records keep their numeric IDs. This package owns the Cin7 HTTP surface: GUIDs derived from those IDs (`guid`, `recordOf`), Cin7 field names, `Page`/`Limit` paging (at most 1,000), `UpdatedSince`/`ModifiedSince` filters, `api-auth-accountid` and `api-auth-applicationkey` authentication (403 when rejected) and the 60-calls-per-minute limit (429). The host table is `sim_cin7_records`. Exports point to compiled `dist` output.

## Model

- **Sales** are the model's sales orders. Each delivery note is a fulfilment with authorised pick, pack and ship steps; a note still being packed has an authorised pick, a draft pack and no shipment, and unshipped work has no fulfilment yet. Orders with a shop order number report it as the customer reference from the `Shopify` channel.
- **Stock** has one row per product and location. Reservations are per item in the model, so `allocation` spreads them over locations in configured order up to each location's stock and puts the rest on the first location; `availableAt` gives the per-location availability the host's stock sync pushes to shops.
- **Credit notes** are always empty; the simulated merchant handles returns in the shops.
- **Purchases** report receipts booked on the order as one authorised stock receipt.

## Validation

`pnpm test:simulator` runs `tooling/simulator/cin7-contract.test.mjs`, which drives the real Cin7 adapter against this package.

## Further reading

- [Simulator](../../../docs/simulator.md#cin7-core-as-the-erp)
- [Cin7](../../../docs/cin7.md)
