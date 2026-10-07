# Commerce simulator

The simulator plays a merchant's commerce systems: several Shopify stores and one JTL-Wawi ERP, the integration between them, a warehouse, carriers, customers and suppliers. Luma connects to it through its real installed adapters, the commerce sync runner and the Shopify webhook route. It never reads simulator data any other way. The simulator also records ground truth about the incidents it causes, so it can score what Luma detected.

`pnpm simulator` includes local Grafana diagnostics for the pilot API, worker and simulator. See [local performance diagnostics](local-observability.md#pilot-and-simulator).

## Start it

Run `mise exec -- pnpm simulator` from the repository root. It starts PostgreSQL, Temporal and Grafana, builds the packages and the control panel, provisions the `luma_simulator` database, creates the run `pilot-44`, provisions a Luma workspace with one connection per simulated system, and starts the simulator, Luma API, worker and web app. Docker and the repository's Node 24 / pnpm toolchain are required.

| Flag                  | Default     | Effect                                                                                |
| --------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `--profile`           | `large`     | Merchant profile for a new run: `test`, `small`, `mid-market` or `large`.             |
| `--chaos`             | `realistic` | Failure preset for a new run: `calm`, `realistic`, `bad-day` or `outage-drill`.       |
| `--seed`              | `44`        | Seed for a new run. The same profile, chaos and seed produce the same merchant.       |
| `--approval-required` | off         | Adds the synthetic shipping-method approval example to a newly provisioned workspace. |
| `--no-demo-workflows` | demo on     | Skips the [workflow demo](#workflow-demo) setup in a newly provisioned workspace.     |
| `--detection`         | `demo`      | `demo` uses faster stuck and hold windows; `production` uses the default thresholds.  |

Flags only apply when the run does not exist yet. Open <http://127.0.0.1:5890> for the control panel. Credentials for Luma are in `.luma/simulator-login.json`.

The large profile generates about 40,000 SKUs and two days of order history, so the first start takes a few minutes; the console reports progress. Luma then imports the full history through commerce sync. That is deliberate: it exercises the platform at the size of a real customer. Use `--profile small` for a faster loop.

`mise exec -- pnpm simulator:service` starts only the simulator and its panel, without Luma. Optional settings are `LUMA_SIMULATOR_PORT` and `LUMA_SIMULATOR_TOKEN`. The panel's local token is a public development value.

## Merchant profiles

Profiles live in `packages/simulator/commerce/src/profiles.ts`. The world generated from a profile and seed is deterministic.

| Profile      | Shops                       | Warehouses | SKUs    | Orders/day | History |
| ------------ | --------------------------- | ---------- | ------- | ---------- | ------- |
| `test`       | 1                           | 1          | 2       | manual     | none    |
| `small`      | 1                           | 1          | ~600    | 200        | 3 days  |
| `mid-market` | 2 (DE, AT)                  | 2          | ~6,000  | 1,000      | 2 days  |
| `large`      | 3 (DE, AT, CH; EUR and CHF) | 3          | ~40,000 | 5,000      | 2 days  |

The world works like a real merchant setup:

- **Demand:** orders arrive per shop following its local time of day and weekday. The large profile adds a weekly tenfold flash sale. Baskets have several lines and follow a long-tail popularity curve, so a few SKUs sell often and most rarely. Some payments stay pending or fail, a few orders go to a fraud check, and customers cancel some orders.
- **Integration:** a middleware imports paid shop orders into JTL after a lag, with the shop order name as JTL's external order number. It pushes JTL availability to every shop that lists an item every few minutes, and books JTL shipments into the shop after a lag. Shop locations mirror JTL's total availability.
- **Warehouse:** each warehouse picks the oldest orders within its staffed hours and hourly capacity. Lines without stock wait as backorders, and lines in stock ship separately.
- **Carriers and returns:** parcels are delivered after a carrier-specific transit time. Delivered lines come back at category-specific rates (fashion about 25 %), and returns move through approval, receipt, refund and closing. Received units return to JTL stock.
- **Suppliers:** the merchant reorders low items in JTL. Suppliers answer purchase orders by their profile: `full`, `partial`, `delayed`, `short` or `silent`. Purchase orders Luma submits get the same answers.

The `test` profile keeps the fixed fixtures that platform tests use: the canvas tote `LUMA-001` (item 1), the unpublished scenario tote `LUMA-SCENARIO-001` (item 2), open orders `1` and `10` in both systems with JTL shipping method `7`, and suppliers `Nordwind Textil GmbH` (1) and `Baltic Packaging AB` (2). Nothing happens on its own. Orders, shipments and stock change only through controls.

## Time

Runs keep real time: the simulation clock follows the wall clock at speed 1, and provider timestamps are current. Luma's freshness, stuck-fulfillment and detection rules use real time, so this is the only mode in which timing rules behave as in production. After downtime, and when a paused run resumes at real-time speed, the clock catches up in five-minute steps, up to one day; longer gaps are skipped. The panel shows when a run is behind or ahead of real time.

**Advance** and speeds above 1× move the run ahead of real time. The panel shows how far ahead it is. Use this to create volume quickly, but don't read timing-based results from Luma while the run is ahead.

## Failures

A run's chaos profile describes three kinds of failure separately. Presets are in `packages/simulator/core/src/presets.ts`; the panel's **Chaos** tab edits every field.

- **Transport:** a share of provider requests fails as unavailable (503), rate limited (429), server error (500), timeout, connection reset, malformed JSON or schema drift. Each kind has a weight. Requests have log-normal latency. A share of committed writes loses its response. Search-backed Shopify list queries lag behind writes. Overrides change the rate for one instance or operation, and timed windows, which may repeat, model outages and degraded periods.
- **Webhooks:** a share is dropped, duplicated or delivered late, out of order.
- **Operational incidents:** the rate per kind, per thousand orders or per day (see the next section).

Except in `calm`, Shopify also enforces its cost-based leaky bucket and answers with `THROTTLED` and cost details, and JTL enforces a request budget with `Retry-After`, so heavy reads are throttled the way real stores throttle them.

Failure decisions are hash-based on the seed, the request identity and how often that request was sent before. Retrying a failed request gets a new decision. The same run fails the same requests even when Luma's workers send them in another order.

| Preset         | Transport errors | Latency median / p99 | Notes                                                      |
| -------------- | ---------------- | -------------------- | ---------------------------------------------------------- |
| `calm`         | none             | 5 ms / 30 ms         | No incidents, perfect webhooks. Used by platform tests.    |
| `realistic`    | 0.3 %, JTL 1 %   | 120 ms / 1.5 s       | Default. Occasional incidents and duplicate webhooks.      |
| `bad-day`      | 8 %              | 400 ms / 6 s         | Shops degraded 15 minutes every three hours; 3× incidents. |
| `outage-drill` | 0.3 %, JTL 1 %   | 120 ms / 1.5 s       | Every provider unavailable 10 minutes every hour.          |

**Service health** forces one instance to rate-limited, unavailable or unauthorized until changed. **Fault rules** reproduce one failure precisely: an instance, an operation (or `*`), an optional resource, the matching request that triggers it, a count and a lifetime in simulation time. Response loss applies after a write commits; every other kind replaces the response. Rules fire in creation order, and their consumption is persisted with the request.

## Incidents and the scorecard

Incident kinds are listed in `packages/simulator/core/src/incidents.ts` with their unit, the Luma exception class that should open a case, and where Luma should show them:

| Incident                                          | Expected case        | What happens                                                       |
| ------------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| Stock sync drift                                  | `inventory_mismatch` | Stock push stops for one shop SKU; shop stock moves away from JTL. |
| Oversell risk                                     | `inventory_mismatch` | Shop shows stock JTL does not have.                                |
| Warehouse stall                                   | `stuck_fulfillment`  | The warehouse never picks an order.                                |
| Shipment not synced                               | `stuck_fulfillment`  | JTL shipped; the shop never receives the shipment.                 |
| Unreleased fraud hold                             | `stuck_fulfillment`  | A fraud hold is never released.                                    |
| Provider outage                                   | `sync_failure`       | One provider is unavailable for 20 to 40 minutes.                  |
| Access revoked                                    | `sync_failure`       | One provider rejects Luma's credentials for an hour.               |
| Order not imported                                | none yet             | The integration drops an order.                                    |
| Shipping method lost                              | none yet             | An express order is imported with standard shipping.               |
| Carrier delay, lost parcel, refund payment failed | none yet             | Shown in Fulfillment or Returns.                                   |

Incidents emerge at the chaos profile's rates, or are injected from the **Incidents** tab or `POST /api/runs/:id/incidents`. Stock and provider incidents start immediately. Order incidents place a new order that carries the incident; it shows as **planned** until the order reaches the affected step. **Recover** repairs the cause the way the merchant would: the stock sync resumes, a dropped order is imported, a stalled pick continues, a hold is released, a shipment is booked, or a shipping method is corrected. Drift incidents also end on their own when the shop matches JTL again, for example after Luma's governed stock correction.

Ground truth stays in the simulator database. The **Scorecard** compares it with Luma's cases, which the local pilot lists through `GET /v1/organizations/:id/simulator/cases`:

- **Detected:** a case of the expected class with the incident's provider records or connection in its evidence. Time to detect is measured from when the incident started.
- **Pending:** no case yet, but still within the rule's detection window.
- **Missed:** no case after that window.
- **Not covered:** no detection rule exists for that kind yet.
- **Cases without ground truth:** false positives, or real problems the simulator didn't label, such as backorders that genuinely stall.
- **Closed without verification:** cases resolved by a verification that wasn't passed, complete and authoritative.
- **Repeated writes:** provider writes committed more than once for the same idempotency key, or the same body when no key was sent.

Luma's sync process runs [scheduled detection](exception-detection.md#scheduled-detection) for sync failures, stock mismatches between linked SKUs and stuck fulfillment. Kinds without a rule report as not covered. A revoked credential makes the connection inactive, which the sync-failure rule treats as clear, so **Credentials revoked** reports as missed.

## Workflow demo

A new workspace is set up the way a merchant would configure Luma, so workflows run on the simulated operations:

- **Case workflows on:** _Correct Shopify stock from the ERP_, _Release an overdue fulfillment hold_ and _Check a failing connection_ are turned on as the workspace owner (`pilot-requester@example.test`). Each change waits in Needs you for a different admin, so sign in with `.luma/simulator-login.json` (`pilot-operator@example.test`) to approve it.
- **Suppliers and stock rules:** the suppliers of the eight most-demanded linked SKUs are created in Procurement and linked to JTL, and each SKU gets a _Replenish low stock_ rule. Two rules start just above current stock, so a purchase-order proposal follows the next fresh stock read. The new run gives these suppliers different answers (full, partial, delayed, short and silent), so sent purchase orders meet each.
- **Detection timing:** with `--detection demo`, fulfillment counts as stuck after 20 minutes instead of two hours, and a hold is overdue after 30 minutes instead of a day. The workspace keeps its timing across restarts.

The API process completes the setup once the records are imported and linked, retrying on each minute's pass; `tooling/simulator/demo.mjs` owns it. JTL stock is reread every 30 minutes, and replenishment acts only on stock read in the last five minutes, so its proposals follow those reads. Approve a proposal within five minutes: after that its evidence is stale and Luma prepares a new one.

**Workflow scenarios** in the Incidents tab start a reproducible situation and state what Luma should do:

| Scenario                     | What happens                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Stock correction             | Stock drift; approve the proposed correction; Luma writes, verifies, and detection closes the case.  |
| Approval expires             | The same drift; leave it for five minutes, and a new proposal from fresh stock replaces the old one. |
| Write commits, response lost | The correction commits but its response is lost; Luma reconciles by reading and never writes twice.  |
| Overdue fraud hold           | A held order; after approval the hold is released, and the case stays open until the order ships.    |
| Shop outage                  | Reads fail; the connection check waits 15 minutes, then ends or hands the case over.                 |
| Access revoked               | Connections shows lost access; no case opens, so the scorecard reports it missed.                    |

A repeated request with the same ID starts nothing new. Definitions live in `packages/simulator/core/src/scenarios.ts`; `POST /api/runs/:id/scenarios` starts one. The incident list links each case to its latest workflow run and shows the run's state.

## Luma wiring

The pilot provisions one connection per instance (`jtl`, then one per shop) with all read capabilities and the write capabilities each provider supports. The simulation manifest `.luma/simulator/pilot.json` binds each connection to its run and instance. The transport selector checks tenant, connection, provider and target, and fails closed for unbound synthetic installations. Simulation is rejected in production.

- **Sync:** the pilot API runs the real commerce sync runner, which imports every capability with its normal backfill, incremental and reconcile schedule. Orders are imported source-local; Luma suggests cross-source order links from the shop order name, but people confirm them.
- **Webhooks:** the simulator delivers signed Shopify webhooks for every change to Luma's real change route (`/v1/shopify/changes/:org/:connection`). The pilot configures a synthetic Shopify app whose client secret is the run's webhook secret. Those settings point to an `.invalid` origin that is never contacted.
- **Links and detection:** imports keep each source's SKUs and locations apart until people link them. Acting as the merchant, the pilot links each shop's stock location to JTL's all-warehouses stock and, 100 per minute, the 500 most-demanded SKUs of the run's catalog (`LUMA_SIMULATOR_LINKED_SKUS` changes the number). Once a minute it then runs the same scheduled detection as the sync worker. Drift on unlinked SKUs is not compared and reports as missed.
- **Inventory monitor:** the pilot links JTL item 2 (all warehouses) to the first shop's inventory item 2 at its location, and runs the inventory monitor with fresh verification for that pair. Inject **Stock sync drift** for `LUMA-SCENARIO-001` (test profile) or the first shop's SKU of item 2 to follow a case through detection and verified resolution. **Check now** in the Incidents tab runs the check immediately.

## Storage and API

Provider records, engine state and ground truth live in the PostgreSQL database `luma_simulator`, on the same server as Luma's database but never in it. Luma's runtime roles have no access to it, so Luma can only learn about provider data through the adapters. The `luma_simulator` role reads and writes data; migrations in `apps/simulator/migrations` run with the owner connection. `pnpm db:reset` drops both databases, and the next `pnpm simulator` provisions a new run and workspace. Simulator workspaces created before the PostgreSQL store are archived to `.luma/backups/simulator-legacy-*` on the next start.

Each provider owns a record table (`sim_shopify_records`, `sim_jtl_records`) with one row per provider record and indexes for keyset paging, parents, lookup keys and modification time. Provider writes and clock ticks lock the run row, so they serialize per run. Reads use their own short transactions. Request metrics and journal entries are written in batches.

The control API at `/api` requires the bearer token. `@luma/simulator-contract` defines its schemas; the panel, pilot and tests use them.

| Request                                                    | Purpose                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/profiles`                                        | Merchant profiles, chaos presets and incident kinds.                                            |
| `GET, POST /api/runs`; `GET, DELETE /api/runs/:id`         | Runs. Creation returns immediately and provisions in the background.                            |
| `POST /api/runs/:id/control`                               | Pause, resume, reset, advance, speed, chaos, health, fault rules, orders and provider commands. |
| `GET /api/runs/:id/journal`, `metrics`, `scorecard`        | Activity, per-minute series and the scorecard.                                                  |
| `GET, POST /api/runs/:id/incidents`; `…/:incident/recover` | Ground-truth incidents.                                                                         |
| `GET /api/runs/:id/records/:instance[/kinds]`              | Provider records, newest first.                                                                 |
| `GET /api/runs/:id/skus?q=`, `…/skus/:sku`                 | SKU search and ERP-to-shop stock comparison.                                                    |
| `PUT /api/runs/:id/webhooks`                               | Webhook targets and secrets per shop.                                                           |
| `GET, POST /api/runs/:id/operations[/check]`               | Luma's inventory check for the bound run.                                                       |
| `POST /api/runs/:id/scenarios`                             | Starts a workflow scenario: its fault rules and incidents, once per request ID.                 |
| `POST /api/runs/:id/providers/:instance/request`           | The provider transport used by Luma's simulation binding.                                       |

## Extending and checking

- **Provider behavior** belongs to `packages/simulator/shopify` and `packages/simulator/jtl`. Shopify serves GraphQL through a schema built for the queries Luma sends, so unknown fields fail validation like the real API. Each provider has contract tests through the real adapters in `tooling/simulator/*-contract.test.mjs`. Simulator compatibility doesn't prove live-provider compatibility.
- **Merchant behavior** belongs to `apps/simulator/src/engine`, profile data to `@luma/simulator-commerce`, and failure decisions to `@luma/simulator-core`.
- **New incident kinds** need their kind entry, where they start in the engine, a recovery, and an expected exception class once a detector exists. Use the [operational scenario recipe](adding-operational-scenarios.md).

Run `mise exec -- pnpm test:simulator` for package tests, the database-backed host tests, adapter contracts and the panel. `pnpm verify:feature simulator` adds the platform journeys. Platform tests reuse `setupSimulator(t)`, which creates a disposable simulator database, a paused `test` run with `calm` failures, and a workspace. They advance time and call `pilot.observe()` explicitly. `observe()` waits for Shopify bulk exports that are still being prepared, so a test's later provider changes aren't hidden behind an import that finishes from an older export.
