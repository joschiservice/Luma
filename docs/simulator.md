# Commerce simulator

The simulator plays a merchant's commerce systems: several Shopify stores, one ERP (JTL-Wawi or Cin7 Core) and a shared Gmail mailbox, the integration between them, a warehouse, carriers, customers and suppliers. Luma connects to it only through its real installed adapters, the commerce sync runner and the Shopify webhook route; it never reads simulator data any other way. The simulator also records ground truth about the incidents it causes, so it can score what Luma detected.

## Start it

`mise exec -- pnpm simulator` starts PostgreSQL, Temporal and the [local diagnostics stack](observability.md#pilot-and-simulator), provisions the `luma_simulator` database and the run `pilot-44`, provisions a Luma workspace with one connection per simulated system, and starts the simulator, Luma API, worker and web app. The control panel is at <http://127.0.0.1:5890>; Luma credentials are in `.luma/simulator-login.json`.

| Flag                  | Default     | Effect                                                                              |
| --------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `--profile`           | `large`     | [Merchant profile](#merchant-profiles)                                              |
| `--chaos`             | `realistic` | Failure preset: `calm`, `realistic`, `bad-day` or `outage-drill`                    |
| `--seed`              | `44`        | The same profile, chaos and seed produce the same merchant                          |
| `--erp`               | profile's   | Runs the merchant on `jtl` (JTL-Wawi) or `cin7` (Cin7 Core) instead of its own ERP  |
| `--history-days`      | profile's   | Days of order history simulated before the run starts, from 0 to 14                 |
| `--approval-required` | off         | Adds the synthetic shipping-method approval example                                 |
| `--no-demo-workflows` | demo on     | Skips the [workflow demo](#workflow-demo) setup                                     |
| `--detection`         | `demo`      | `demo` shortens stuck, hold and follow-up windows; `production` uses default timing |

Flags apply only when the run does not exist yet. `pnpm db:reset` drops both Luma's and the simulator's databases; the next start provisions a new run and workspace.

The `large` profile generates about 40,000 SKUs across three shops and two days of order history, and Luma imports all of it through commerce sync, so the first start takes minutes. That is deliberate: it exercises the platform at a real customer's size. Use `--profile small` or `--history-days 0` for a faster loop. `pnpm simulator:service` starts only the simulator and its panel, without Luma; the panel's local token is a public development value.

## Merchant profiles

A profile describes a business as such merchants typically run it: company, region and currencies, catalog, shops, warehouses, carriers, suppliers, demand and usual ERP. `--erp` runs the same business on the other ERP to test compatibility; regional profiles are the realistic setups to validate against.

| Profile         | ERP       | Merchant                                                                                                                       |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `test`          | JTL-Wawi  | Fixed fixtures for platform tests: two products, one shop, nothing happens on its own                                          |
| `small`         | JTL-Wawi  | One German shop and warehouse, about 600 SKUs and 200 orders a day                                                             |
| `mid-market`    | JTL-Wawi  | German and Austrian shops, two warehouses, about 6,000 SKUs and 1,000 orders a day                                             |
| `large`         | JTL-Wawi  | Three DACH shops and warehouses, about 40,000 SKUs and 5,000 orders a day with weekly flash sales                              |
| `dach-beauty`   | JTL-Wawi  | Natural cosmetics: DE and AT shops, one warehouse, multi-item baskets of low-priced products, few returns, drugstore wholesale |
| `anz-lifestyle` | Cin7 Core | Home and apparel: AU and NZ shops in AUD and NZD, Sydney and Auckland warehouses, retailer wholesale, Asian supply             |
| `uk-us-dtc`     | Cin7 Core | Outdoor brand: UK shop from its own warehouse, US shop in USD from a 3PL, US sales tax added at checkout                       |

## The simulated merchant

A profile and seed generate a deterministic world that behaves like a real setup:

- **Region:** customers get names, addresses and phone numbers of their shop's country. Shops charge their country's sales tax, included in prices except in the US, where checkout adds it per line. The ERP books in the profile's base currency and records each order's own currency and tax rate.
- **Demand:** orders follow each shop's local time of day and weekday; some profiles add promotions such as a weekly flash sale. Baskets follow a long-tail popularity curve. Some payments stay pending or fail, some orders go to a fraud check, and customers cancel some.
- **Integration:** a middleware imports paid shop orders into the ERP after a lag, with the shop order name as the ERP's external order number. It pushes ERP availability to every shop every few minutes and books ERP shipments into the shop after a lag.
- **Wholesale:** profiles with a wholesale channel book retailer orders directly in the ERP on weekdays during business hours. They have no shop order and no external order number, ship from their warehouse, and are paid on invoice terms weeks later. **Place a wholesale order** on the panel, or the control action `wholesale-order`, books one on demand.
- **Warehouse:** each warehouse picks the oldest orders within staffed hours in its own time zone and within its hourly capacity. Lines without stock wait as backorders; lines in stock ship separately.
- **Carriers and returns:** each warehouse ships with the carriers that collect there. Delivered lines come back at category-specific rates, and returns move through approval, receipt, refund and closing. Received units return to ERP stock.
- **Suppliers:** the merchant reorders low items in the ERP with the profile's lead time, such as weeks for sea freight from Asia. Suppliers answer purchase orders, including those Luma submits, by their profile: `full`, `partial`, `delayed`, `short` or `silent`.
- **Mail:** the ERP emails each purchase order from the operations mailbox, and suppliers answer by email as they confirm. Customers write when their parcel is delayed. See [operations mailbox](#operations-mailbox).

The `test` profile holds the fixed fixtures that platform tests rely on and does nothing on its own: orders, shipments and stock change only through controls.

### Cin7 Core as the ERP

On Cin7 the same ERP model (orders, shipments, stock, purchasing and suppliers) answers through Cin7 Core's API, and Luma connects through the read-only Cin7 app. Records keep their numeric IDs inside the simulator and appear to Luma as stable GUIDs. Warehouses are Cin7 locations. The account, customers and suppliers use the profile's base currency; a sale in another currency reports it as `CustomerCurrency` with the `CurrencyRate` to the base currency. Sale lines carry net prices and tax, and the order total includes tax. Shop sales carry the shop channel and the shop order number as customer reference; wholesale sales have neither, so Luma suggests no link for them. The ERP model reserves stock per item, not per warehouse, so the stock report spreads each item's reservations over its locations in configured order, up to each location's stock, and puts the rest on the first location. The simulated stock sync pushes the same per-location number to the shop that sells that warehouse, so linked stock compares like for like.

Cin7 holds no credit notes here, because returns happen in the shops. Luma sends nothing to Cin7, so supplier links and stock rules work but purchase-order proposals stay unsent, and the shipping-method approval example does not apply. Cin7 allows 60 requests per minute, and Luma reads each sale separately, so a day of history takes Luma minutes to import and the `large` profile takes hours. That matches a real first import; use `--history-days 0` for a quick loop.

## Operations mailbox

Every run has one Gmail mailbox, instance `gmail`, at the profile's address, such as `einkauf@luma-goods.example`. Its reserved `.example` domain means mail can never reach a real recipient. Luma reads it through the real Gmail app with a token connection; the simulator also answers Google's token endpoint, so OAuth refresh can be exercised against it.

The merchant world writes the mail:

- **Purchase orders:** a few seconds after a purchase order is recorded, the ERP's email `Bestellung BE-…` or `Purchase order BE-…` leaves the mailbox with the order as a PDF in the merchant's language. Suppliers reply in the same thread when they confirm: in full with an order-confirmation PDF, with a split delivery and a CSV delivery schedule when they confirm less than ordered (`partial`), or with a new date (`delayed`). Silent suppliers write nothing. A German-speaking merchant and supplier write German to each other; everyone else writes English. Texts depend only on the seed and the order, so they repeat.
- **Customers:** when a carrier reports a parcel delayed, the customer writes in about half of the cases, quoting the order name such as `#DE1001`.

The **Mailbox** tab lists threads and messages and delivers mail as a supplier, customer or anyone else, optionally as a reply in the selected thread. The control API accepts the same `deliver` and `seed-mailbox` commands for instance `gmail`.

Gmail push is not simulated: `watch` succeeds, but no Pub/Sub notification reaches Luma, which needs Google-signed tokens. Luma finds new mail by polling, so it appears on the next mailbox read rather than at once. Search lags behind new mail like the other providers' search, and a message sent twice is stored twice, so duplicate sends show in the mailbox and in the scorecard's repeated writes.

## Time

Runs keep real time: at speed 1 the clock follows the wall clock and provider timestamps are current. Luma's freshness, stuck-fulfillment and detection rules use real time, so this is the only mode in which timing rules behave as in production. After downtime, or when a paused run resumes, the clock catches up in five-minute steps for up to one day; longer gaps are skipped.

**Advance** and speeds above 1× move the run ahead of real time. Use them to create volume, but don't read timing-based results from Luma while the run is ahead. The panel shows when a run is behind or ahead.

## Failures

A run's chaos profile sets three kinds of failure separately:

- **Transport:** a weighted share of provider requests fails as 503, 429, 500, timeout, connection reset, malformed JSON or schema drift, with log-normal latency. A share of committed writes loses its response. Search-backed Shopify list queries lag behind writes. Per-instance or per-operation overrides and repeating timed windows model outages.
- **Webhooks:** a share is dropped, duplicated or delivered late and out of order.
- **Operational incidents:** a rate per kind, per thousand orders or per day.

Except in `calm`, Shopify enforces its cost-based leaky bucket and answers `THROTTLED` with cost details, and JTL enforces a request budget with `Retry-After`. `calm` has no failures and is what platform tests use; `outage-drill` makes every provider unavailable for 10 minutes each hour.

Failure decisions hash the seed, the request identity and how often that request was sent before. A retry gets a new decision, and the same run fails the same requests even when Luma's workers send them in another order.

**Service health** forces one instance to rate-limited, unavailable or unauthorized until changed. **Fault rules** reproduce one failure precisely by instance, operation (or `*`), optional resource, count and lifetime in simulation time. Response loss applies after a write commits; every other kind replaces the response. Rules fire in creation order, and their consumption is persisted with the request.

## Incidents and the scorecard

Each incident kind in `@luma/simulator-core` declares the case class Luma should open, or none where Luma shows it elsewhere or has no rule yet. Incidents emerge at the chaos rates or are injected from the panel or API. Stock and provider incidents start immediately; order incidents place a new order that carries the incident and stay **planned** until the order reaches the affected step. **Recover** repairs the cause the way the merchant would. Drift incidents also end on their own when the shop matches JTL again, for example after Luma's governed stock correction.

Ground truth stays in the simulator database. The scorecard compares it with Luma's cases, which the pilot lists through a simulator-only API route:

- **Detected:** a case of the expected class with the incident's provider records or connection in its evidence. Time to detect counts from the incident's start.
- **Pending:** no case yet, still within the rule's detection window. **Missed:** no case after it.
- **Not covered:** no detection rule exists for that kind.
- **Cases without ground truth:** false positives, or real problems the simulator didn't label, such as backorders that genuinely stall.
- **Closed without verification:** resolved by a verification that wasn't passed, complete and authoritative.
- **Repeated writes:** provider writes committed more than once for the same idempotency key, or the same body when no key was sent.

The sync process runs [scheduled detection](exception-detection.md#scheduled-detection). A rejected credential revokes the connection and the sync-failure rule reports the lost access. To close that case, reconnect the store with any token; the simulator accepts it once the incident ends.

## Workflow demo

Unless `--no-demo-workflows` is set, a new workspace is configured the way a merchant would configure Luma:

- The case workflows (stock correction, hold release, order quantity change, connection check and the supplier, refund and payment follow-ups) are turned on by the workspace owner, `pilot-requester@example.test`. Each activation waits in Needs you for a different admin; sign in as `pilot-operator@example.test` from `.luma/simulator-login.json` to approve it.
- The suppliers of the eight most-demanded linked SKUs are created in Procurement and linked to JTL, and each SKU gets a low-stock replenishment rule. Two rules start just above current stock, so a purchase-order proposal follows the next fresh stock read. These suppliers answer differently, so sent purchase orders meet each supplier behavior.
- With `--detection demo`, fulfillment is stuck after 20 minutes instead of two hours, a hold is overdue after 30 minutes instead of a day, the supplier follow-up waits 15 minutes, refunds count as missing 8 hours after items arrive and payments 1 hour after the order. The workspace keeps its timing across restarts.

The API completes the setup once records are imported and linked, retrying on each minute's pass. Proposals stay open for four hours. Luma rereads stock right before acting, and replenishment rereads its rules' stock while they wait.

**Workflow scenarios** in the panel start a reproducible situation and state what Luma should do; their definitions and expected outcomes live in `@luma/simulator-core`. Repeating a request with the same ID starts nothing new. The incident list links each case to its latest workflow run.

**Customer changes a quantity** records a scenario-only incident for the first shop's newest open order that the ERP imported and has not shipped, with a line of at least two units. The pilot then acts as the merchant's support: it links the shop order with its ERP import and the line's SKU, accepts the order into Luma's own records, makes Luma ERP the order-line and lifecycle authority, and lowers the line by one unit in Luma. The shop and JTL keep the original order, so the quantity rule opens a case once they are read again after the propagation window, and the order quantity change carries it; a warehouse member answers its task as `pilot-warehouse@example.test`. Simulator runs release Luma's order records (`FEATURE_FLAG_OVERRIDES=luma-erp-orders=true` unless set otherwise). The JTL control command `unpack` removes a delivery note that is still being packed, as a warehouse that stops packing to pick again.

Two scenarios act through the mailbox and record scenario-only incidents that never emerge on their own. **Supplier split delivery by email** answers the newest purchase order its supplier has left unanswered for a minute; without one, the merchant orders the first shop's bestseller and suppresses that supplier's own answer. The email ships about 60% in three days and the rest a week later, and the ERP stays unconfirmed until **Recover** books the emailed quantities. **Customer asks about a late order** has the customer of the first shop's newest order write about it.

The demo also adds inbox rules once its suppliers exist: each demo supplier's order address, linked to its Procurement supplier, and catch-alls for `supplier.example` and `customer.example`. The workspace needs the operations inbox for this step.

## Luma wiring

The pilot provisions one connection per instance (the ERP, one per shop and the mailbox) with all read capabilities and the write capabilities each provider supports; the mailbox may read messages, threads and attachments and send. A checkout without the Gmail app skips the mailbox. The manifest `.luma/simulator/pilot.json` binds each connection to its run and instance. The transport selector checks tenant, connection, provider and target, and fails closed for unbound synthetic installations. Simulation is rejected in production.

- **Sync:** the pilot API runs the real commerce sync runner with its normal backfill, incremental and reconcile schedule. Orders are imported source-local; Luma suggests cross-source links from the shop order name, and people confirm them.
- **Webhooks:** the simulator delivers signed Shopify webhooks for every change to Luma's real change route. The pilot configures a synthetic Shopify app whose client secret is the run's webhook secret; its settings point to an `.invalid` origin that is never contacted.
- **Links and detection:** imports keep each source's SKUs and locations apart until linked. Acting as the merchant, the pilot links each shop's location to JTL's all-warehouses stock and, 100 per minute, the 500 most-demanded SKUs (`LUMA_SIMULATOR_LINKED_SKUS` changes the number). Once a minute it runs the same scheduled detection as the sync worker. Drift on unlinked SKUs is never compared and reports as missed.
- **Inventory monitor:** the pilot links JTL item 2 to the first shop's item 2 and runs the inventory monitor with fresh verification for that pair. Inject **Stock sync drift** for that SKU to follow a case through detection and verified resolution; **Check now** runs the check immediately.

## Storage and API

Provider records, engine state and ground truth live in the PostgreSQL database `luma_simulator`, on the same server as Luma's database but never in it. Luma's runtime roles have no access to it, so Luma learns about provider data only through the adapters. The `luma_simulator` role reads and writes data; simulator migrations run with the owner connection.

Each provider owns a record table with one row per provider record. Provider writes and clock ticks lock the run row, so they serialize per run; reads use their own short transactions. Request metrics and journal entries are written in batches.

The control API at `/api` requires the bearer token (`LUMA_SIMULATOR_TOKEN`), and `@luma/simulator-contract` defines its schemas for the panel, pilot and tests. Run creation returns immediately and provisions in the background.

## Extending and testing

- **Provider behavior** belongs to `@luma/simulator-shopify`, `@luma/simulator-jtl`, `@luma/simulator-cin7` and `@luma/simulator-gmail`. Simulator packages depend only on simulator core, so the host composes the Cin7 account with the JTL package's ERP model. Shopify serves GraphQL through a schema built for the queries Luma sends, so unknown fields fail validation like the real API. Simulator compatibility does not prove live-provider compatibility.
- **Merchant behavior** belongs to the simulator engine, profile data to `@luma/simulator-commerce` and failure decisions to `@luma/simulator-core`.
- **New incident kinds** need a kind entry, a start in the engine, a recovery, and an expected case class once a detector exists. Follow the [operational scenario recipe](adding-operational-scenarios.md).

Platform tests use `setupSimulator(t)`: a disposable simulator database, a paused `test` run with `calm` failures, and a workspace. They advance time and call `pilot.observe()` explicitly. `observe()` waits for Shopify bulk exports still being prepared, so later provider changes aren't hidden behind an import that finishes from an older export.
