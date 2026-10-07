# Commerce simulator

The simulator plays a merchant's commerce systems: several Shopify stores and one JTL-Wawi ERP, the integration between them, a warehouse, carriers, customers and suppliers. Luma connects to it only through its real installed adapters, the commerce sync runner and the Shopify webhook route; it never reads simulator data any other way. The simulator also records ground truth about the incidents it causes, so it can score what Luma detected.

## Start it

`mise exec -- pnpm simulator` starts PostgreSQL, Temporal and the [local diagnostics stack](observability.md#pilot-and-simulator), provisions the `luma_simulator` database and the run `pilot-44`, provisions a Luma workspace with one connection per simulated system, and starts the simulator, Luma API, worker and web app. The control panel is at <http://127.0.0.1:5890>; Luma credentials are in `.luma/simulator-login.json`.

| Flag                  | Default     | Effect                                                                              |
| --------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `--profile`           | `large`     | Merchant profile: `test`, `small`, `mid-market` or `large`                          |
| `--chaos`             | `realistic` | Failure preset: `calm`, `realistic`, `bad-day` or `outage-drill`                    |
| `--seed`              | `44`        | The same profile, chaos and seed produce the same merchant                          |
| `--approval-required` | off         | Adds the synthetic shipping-method approval example                                 |
| `--no-demo-workflows` | demo on     | Skips the [workflow demo](#workflow-demo) setup                                     |
| `--detection`         | `demo`      | `demo` shortens stuck, hold and follow-up windows; `production` uses default timing |

Flags apply only when the run does not exist yet. `pnpm db:reset` drops both Luma's and the simulator's databases; the next start provisions a new run and workspace.

The `large` profile generates about 40,000 SKUs across three shops and two days of order history, and Luma imports all of it through commerce sync, so the first start takes minutes. That is deliberate: it exercises the platform at a real customer's size. Use `--profile small` for a faster loop. `pnpm simulator:service` starts only the simulator and its panel, without Luma; the panel's local token is a public development value.

## The simulated merchant

A profile and seed generate a deterministic world that behaves like a real setup:

- **Demand:** orders follow each shop's local time of day and weekday; the large profile adds a weekly flash sale. Baskets follow a long-tail popularity curve. Some payments stay pending or fail, some orders go to a fraud check, and customers cancel some.
- **Integration:** a middleware imports paid shop orders into JTL after a lag, with the shop order name as JTL's external order number. It pushes JTL availability to every shop every few minutes and books JTL shipments into the shop after a lag.
- **Warehouse:** each warehouse picks the oldest orders within staffed hours and hourly capacity. Lines without stock wait as backorders; lines in stock ship separately.
- **Carriers and returns:** delivered lines come back at category-specific rates, and returns move through approval, receipt, refund and closing. Received units return to JTL stock.
- **Suppliers:** the merchant reorders low items in JTL. Suppliers answer purchase orders, including those Luma submits, by their profile: `full`, `partial`, `delayed`, `short` or `silent`.

The `test` profile holds the fixed fixtures that platform tests rely on and does nothing on its own: orders, shipments and stock change only through controls.

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

- The case workflows (stock correction, hold release, connection check and the supplier, refund and payment follow-ups) are turned on by the workspace owner, `pilot-requester@example.test`. Each activation waits in Needs you for a different admin; sign in as `pilot-operator@example.test` from `.luma/simulator-login.json` to approve it.
- The suppliers of the eight most-demanded linked SKUs are created in Procurement and linked to JTL, and each SKU gets a low-stock replenishment rule. Two rules start just above current stock, so a purchase-order proposal follows the next fresh stock read. These suppliers answer differently, so sent purchase orders meet each supplier behavior.
- With `--detection demo`, fulfillment is stuck after 20 minutes instead of two hours, a hold is overdue after 30 minutes instead of a day, the supplier follow-up waits 15 minutes, refunds count as missing 8 hours after items arrive and payments 1 hour after the order. The workspace keeps its timing across restarts.

The API completes the setup once records are imported and linked, retrying on each minute's pass. Proposals stay open for four hours. Luma rereads stock right before acting, and replenishment rereads its rules' stock while they wait.

**Workflow scenarios** in the panel start a reproducible situation and state what Luma should do; their definitions and expected outcomes live in `@luma/simulator-core`. Repeating a request with the same ID starts nothing new. The incident list links each case to its latest workflow run.

## Luma wiring

The pilot provisions one connection per instance (`jtl`, then one per shop) with all read capabilities and the write capabilities each provider supports. The manifest `.luma/simulator/pilot.json` binds each connection to its run and instance. The transport selector checks tenant, connection, provider and target, and fails closed for unbound synthetic installations. Simulation is rejected in production.

- **Sync:** the pilot API runs the real commerce sync runner with its normal backfill, incremental and reconcile schedule. Orders are imported source-local; Luma suggests cross-source links from the shop order name, and people confirm them.
- **Webhooks:** the simulator delivers signed Shopify webhooks for every change to Luma's real change route. The pilot configures a synthetic Shopify app whose client secret is the run's webhook secret; its settings point to an `.invalid` origin that is never contacted.
- **Links and detection:** imports keep each source's SKUs and locations apart until linked. Acting as the merchant, the pilot links each shop's location to JTL's all-warehouses stock and, 100 per minute, the 500 most-demanded SKUs (`LUMA_SIMULATOR_LINKED_SKUS` changes the number). Once a minute it runs the same scheduled detection as the sync worker. Drift on unlinked SKUs is never compared and reports as missed.
- **Inventory monitor:** the pilot links JTL item 2 to the first shop's item 2 and runs the inventory monitor with fresh verification for that pair. Inject **Stock sync drift** for that SKU to follow a case through detection and verified resolution; **Check now** runs the check immediately.

## Storage and API

Provider records, engine state and ground truth live in the PostgreSQL database `luma_simulator`, on the same server as Luma's database but never in it. Luma's runtime roles have no access to it, so Luma learns about provider data only through the adapters. The `luma_simulator` role reads and writes data; simulator migrations run with the owner connection.

Each provider owns a record table with one row per provider record. Provider writes and clock ticks lock the run row, so they serialize per run; reads use their own short transactions. Request metrics and journal entries are written in batches.

The control API at `/api` requires the bearer token (`LUMA_SIMULATOR_TOKEN`), and `@luma/simulator-contract` defines its schemas for the panel, pilot and tests. Run creation returns immediately and provisions in the background.

## Extending and testing

- **Provider behavior** belongs to `@luma/simulator-shopify` and `@luma/simulator-jtl`. Shopify serves GraphQL through a schema built for the queries Luma sends, so unknown fields fail validation like the real API. Simulator compatibility does not prove live-provider compatibility.
- **Merchant behavior** belongs to the simulator engine, profile data to `@luma/simulator-commerce` and failure decisions to `@luma/simulator-core`.
- **New incident kinds** need a kind entry, a start in the engine, a recovery, and an expected case class once a detector exists. Follow the [operational scenario recipe](adding-operational-scenarios.md).

Platform tests use `setupSimulator(t)`: a disposable simulator database, a paused `test` run with `calm` failures, and a workspace. They advance time and call `pilot.observe()` explicitly. `observe()` waits for Shopify bulk exports still being prepared, so later provider changes aren't hidden behind an import that finishes from an older export.
