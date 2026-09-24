# Stateful commerce simulator

`pnpm simulator` includes local Grafana diagnostics for the pilot API, worker, and simulator, including SQLite and simulation timings. See [local performance diagnostics](local-observability.md#pilot-and-simulator).

Run `mise exec -- pnpm simulator` from the repository root. It starts local PostgreSQL and Temporal, builds the packages, provisions synthetic installations, and starts the simulator, control panel, Luma API, worker, and web app. The command prints the Luma URL and manifest path. Docker and the repository's Node 24 / pnpm toolchain are required.

Open <http://127.0.0.1:5890> and click **Connect**. The default local token is prefilled. Select `pilot-44`. New workspaces start healthy in a manual sandbox. Credentials for Luma are in `.luma/simulator-login.json`.

Under **Operational issues**, click **Create mismatch**. The simulator pauses commerce and sets Shopify's available stock ten units above JTL's available stock for a dedicated canvas tote test stock pool. Autonomous orders use a separate stock pool. Luma reads both providers, detects the mismatch, and records its evidence. **Open case in Luma** opens that case.

Click **Match stock** to set Shopify availability to JTL's current availability while preserving reservations. The panel shows **Problem removed** separately from **Case resolved**. **Check now** runs detection and, when the stock agrees, independent verification. Background checks also run every ten seconds. A provider outage, incomplete read, stale evidence, or conflicting mapping leaves the case open. After resolution, **Create mismatch** starts another occurrence linked to the previous case; no reset is needed.

Existing workspaces retain their data and startup scenario. To provision the shipping approval example in a new workspace, use `pnpm simulator --approval-required`. The approval review refreshes expired evidence on the same case. Before approval it rereads the order; changed methods, cancelled or shipped orders, and unknown states stop the correction. Use **Retry checks** after a temporary read failure.

For the simulator and panel alone, use `mise exec -- pnpm simulator:service`. Create a run in the panel. This command does not provision Luma installations. Optional service settings are `LUMA_SIMULATOR_PORT`, `LUMA_SIMULATOR_TOKEN`, and `LUMA_SIMULATOR_STORE`.

## Connections and provider state

The provisioned connections are labeled `SIMULATED`. `.luma/simulator/pilot.json` records their tenant, connection, run, provider instance, and exact provider target. `transport.json` contains the same routing configuration. Synthetic credentials are encrypted through the existing installation service. The API and worker load the same manifest; they use the existing installed capability runtime, provider clients, adapters, evidence recording, execution, and verification paths.

The transport selector checks tenant, connection ID, provider, and target. Missing bindings for marked synthetic installations fail closed. Simulation is rejected in production. Production JTL address pinning remains in place. No provider connector depends on simulator code. The simulation service binds to loopback and requires its token for every data/control endpoint.

Provider truth lives in the simulator database, separately from the pilot's observation/evidence file and Luma's PostgreSQL data. Inspection shows provider-shaped records, including order lines, stock quantities, fulfillment relationships, and JTL shipping methods. The simulated provider instances are `jtl` and `shopify` within each run. Runs have separate state, clocks, queues, rules, journals, and ID mappings.

## Scenarios and time

Both scenarios seed orders `1` and `10`, a canvas tote SKU, 100 units of initial stock, and JTL shipping methods `7` (Standard), `8` (Express), and `9` (Pickup).

- **Autonomous commerce:** every 30 simulation seconds, a merchant order reserves Shopify stock. An explicit mapping propagates the order to JTL after five seconds. JTL ships after 20 seconds; Shopify receives shipment progress five seconds later. These are simulated merchant/integration actions, not work assigned to Luma. Luma's shipping-method correction is performed only through its real execution path.
- **Manual sandbox:** no recurring events. Use merchant actions to create orders, set stock, ship an order, or change its JTL shipping method.

Seeded randomness determines quantities; generated order IDs start at `11`. Use IDs outside the scenario's generated sequence for manual orders. The journal records manual commands, scheduled events, requests, writes, responses, and faults with stable sequence numbers and affected resource IDs. Equal-time events run by insertion order.

Pause stops autonomous commerce. Provider reads and control requests remain available. **Advance 30s** advances scheduled events even while paused. Speed changes affect commerce time; HTTP cancellation and client timeouts use real time. The host runs without a browser. It advances by fixed 250 ms ticks, multiplied by speed, and does not catch up for process downtime or event-loop stalls.

## Service health

Choose a provider and set **Service health** in the control panel. Each run stores independent JTL and Shopify settings:

- **Healthy:** requests use normal provider behavior and any armed faults.
- **Rate limited:** every request returns HTTP 429 with `Retry-After: 1`.
- **Unavailable:** every request returns HTTP 503 with `Retry-After: 1`.

Health settings persist across restarts, pause, and clock advances until changed. **Reset run** restores both providers to healthy. Existing runs without health settings start healthy. Blocked requests do not read or change provider records or consume fault rules. Fault lifetimes still advance with simulation time. Merchant actions and scheduled commerce continue independently of provider API health. Health changes and blocked responses appear in the journal.

The full-stack simulator reads each permitted provider capability when its API starts and every ten real-time seconds after the previous pass finishes. Reads continue while commerce is paused. Commerce observations go through Luma's ingestion service; read outcomes, including empty results, are stored for Overview coverage. Provider failures show the connection as degraded in Overview until a later read succeeds. Healthy means that recent reads succeeded; it does not clear existing cases or operator decisions. The control panel alone does not collect Luma observations.

Restart `pnpm simulator` after updating the code to apply the database migration and start the observation collector. Overview refreshes automatically; allow one collection pass and a UI refresh after changing health.

The control API accepts `{ "action": "service-health", "instance": "jtl", "status": "unavailable" }` at `POST /api/runs/:id/control`. Instances are `jtl` and `shopify`; statuses are `healthy`, `rate-limited`, and `unavailable`.

## Faults and uncertain writes

Select a provider, fault, operation, optional resource, occurrence, count, and lifetime. Rules move from **armed** to **triggered**, **expired**, or **disabled**. Lifetimes use simulation time. Occurrence counts matching requests; count controls how many faults follow that occurrence. Rules are evaluated in creation order and the first eligible rule wins per request phase.

- **Outage:** returns HTTP 503 with retry advice.
- **Rate limit:** returns HTTP 429 with `Retry-After: 1`.
- **Response lost:** applies only to JTL `orders.shipping-method.write`, after commit. The mutation, journal entry, and fault consumption commit in one SQLite transaction before transport failure is reported.

JTL products and inventory share the `items.read` provider operation. Shopify operations are identified from the connector's GraphQL queries. JTL resource targets use numeric sales-order, delivery-note, or item IDs for detail and nested requests; Shopify uses global IDs.

To reproduce an uncertain write, arm response loss for JTL order `10` before approving the pilot correction. The connector reports an unknown effect requiring reconciliation. A fresh authoritative read can prove the shipping method changed; the existing execution path must not blindly redispatch. `pnpm test:simulator` proves this through the installed runtime across a service restart and asserts there is only one provider write.

A merchant action can change the shipping method while Luma is running. The integration suite also places an external change precisely between preflight and PATCH. The simulator deliberately does not invent compare-and-swap or idempotency guarantees; the PATCH can overwrite that external change.

## Persistence, reset, and reproduction

Stop the simulator before running `pnpm db:reset`. The reset archives pilot and simulator state under `.luma/backups/database-reset-*`. The next `pnpm simulator` launch creates a new run and provisions its installations in the new database.

The full-stack command stores provider runs in `.luma/simulator/runs.sqlite` using SQLite WAL and full synchronous commits. Each request or clock tick loads the current snapshot and commits provider state, pending events, rule consumption, and journal together. Failed transactions roll back. A crash before commit leaves the event pending; a crash after commit leaves it consumed. Restart preserves running/paused state without replaying committed transitions. Run only one service runner per database. A failed scheduled transition rolls back that tick, pauses the affected run, and records a scenario error; other runs continue. Fix the conflicting provider state or reset before resuming.

**Reset run** replaces provider state, scheduled events, scenario instances, journal, and faults using the original seed and scenario; it pauses the run. Its clock starts after the previous run time and JTL item timestamps so provider changes remain ordered and Luma can accept the reset stock as a new observation. Luma retains its cases, evidence, and execution records. **Check now** can verify an open inventory case against the reset stock. To provision a fresh workspace, stop the stack, move `.luma/simulator` aside, and restart `pnpm simulator` (or `pnpm simulator --approval-required` for the shipping example); a new isolated organization is provisioned. Keep the old directory when retaining reproduction evidence.

To reproduce provider behavior, create the same seed/scenario, replay journaled manual controls in sequence, and advance the clock by the recorded amounts. Request ordering matters for occurrence-based faults; replay those requests in journal order. Run state, scenario request IDs, and journals are local development data and grow until reset.

## Operational scenario API and platform tests

The panel and automated tests share the same authenticated simulator API:

| Request                                            | Behavior                                                                                                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/runs/:id/scenarios`                     | Accepts `{ "id": "<UUID>", "kind": "inventory-mismatch" }`. Persists the scenario and provider mutation together. Reusing the UUID returns the existing scenario without another mutation. Only one injected mismatch can be active per run. |
| `POST /api/runs/:id/scenarios/:scenarioId/recover` | Matches Shopify stock to current JTL availability. Repeating recovery is a no-op, including after a later scenario starts.                                                                                                                   |
| `GET /api/runs/:id/operations`                     | Returns the latest Luma check, case state, and case link. Runs without provisioned bindings return `connected: false`.                                                                                                                       |
| `POST /api/runs/:id/operations/check`              | Runs a complete inventory check through Luma's authenticated application route, then verifies an existing case if the detection result is clear.                                                                                             |

All simulator requests require its bearer token. The host signs in as the provisioned local operator to call the tenant-scoped Luma routes. The browser never receives the operator password or session. Application routes are registered only by the local pilot runtime and retain the normal session, tenant, origin, and role checks.

`apps/simulator/src/operational-scenarios.ts` owns provider mutations and retry-safe scenario instances. `tooling/simulator/inventory.mjs` provisions explicit canonical SKU and stock-pool bindings: JTL item `2` / `all-warehouses` and Shopify inventory item `2` / location `2`. These records are provisioned for new and existing runs and are separate from the merchant stock used by autonomous commerce. It composes the reusable `createInventoryMonitor` application service from `@luma/resolution`. The monitor completes pagination, reads the mapped records, checks projection currency, and uses the existing inventory rule for detection and independent verification. The simulator stores no copy of Luma's case lifecycle.

Inventory checks use the adapters' observation clock and Luma's evaluation clock, both real time. The simulator clock timestamps provider changes; advancing it does not bypass freshness or detection rules. The inventory scenario needs no timing threshold. Stuck fulfillment and sync failure remain future operational scenarios; the existing service-health and fault controls remain available for provider testing.

The platform suites use an isolated PostgreSQL database, temporary simulator store, healthy workspace, and the same seed and HTTP bridge as the local stack. They assert detection, replay safety, independent verification, recovery during outages, recurrence, reset behavior, and the visible panel journey. Failed tests write provider journals and case evidence to a temporary JSON artifact.

```sh
mise exec -- pnpm test:e2e simulator.e2e.mjs
mise exec -- pnpm test:browser simulator.browser.mjs
```

## Extending and checking

Use the [operational scenario recipe](adding-operational-scenarios.md) to add another issue using the inventory implementation and shared test fixture. Run `pnpm verify:feature simulator` for focused validation with saved logs; see [test tiers](development.md#feature-validation).

`@luma/simulator-core` owns scheduling, fault lifecycle, journal contracts, and the in-process fetch transport. Each provider package owns its own records, commands, protocol handler, and response construction. Providers depend only on core; the host coordinates them through public commands and explicit mappings.

Add provider operations in the owning package and test them through the real client/adapter. Add scenario transitions in `apps/simulator/src/run.ts`. New fault kinds should define their phase, matching fields, validation, response behavior, and durable consumption. Future delayed reads and transport delays must not use the commerce clock for HTTP deadlines. Independent connector schema contract tests remain necessary; simulator compatibility alone does not establish live-provider compatibility.

Run `pnpm test:simulator` for package tests, restart/isolation checks, installed-adapter integration tests, and Playwright control-panel checks. Playwright Chromium must be installed (`pnpm --filter @luma/api exec playwright install chromium`). Run repository checks with `pnpm check`. The simulator does not emulate OAuth, webhooks, or provider operations outside Luma's current adapter surface.
