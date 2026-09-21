# Stateful commerce simulator

Run `mise exec -- pnpm simulator` from the repository root. It starts local PostgreSQL and Temporal, builds the packages, provisions synthetic installations, and starts the simulator, control panel, Luma API, worker, and web app. The command prints the Luma URL and manifest path. Docker and the repository's Node 24 / pnpm toolchain are required.

Open <http://127.0.0.1:5890> and click **Connect**. The default local token is prefilled. Select `pilot-44`, then **Start / Resume**. The Luma pilot starts at an approval-required shipping correction; use its operator account to approve the proposal. Credentials are in `.luma/simulator-login.json`. The approval review refreshes
expired evidence automatically on the same case. Before approval, it rereads the
order; changed methods, cancelled orders, shipped orders, and unknown order
states stop the correction. Use **Retry checks** after a temporary read failure.
A simulator reset is not needed to recover an expired, unapproved proposal.

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

**Reset run** replaces provider state, clock, journal, and faults using the original seed and scenario; it pauses the run. It does not reset Luma's existing execution records. To repeat the complete Luma approval journey, stop the stack, move `.luma/simulator` aside, and restart `pnpm simulator`; a new isolated pilot organization is provisioned. Keep the old directory when retaining reproduction evidence.

To reproduce provider behavior, create the same seed/scenario, replay journaled manual controls in sequence, and advance the clock by the recorded amounts. Request ordering matters for occurrence-based faults; replay those requests in journal order. Run state and journals are local development data and grow until reset.

## Extending and checking

`@luma/simulator-core` owns scheduling, fault lifecycle, journal contracts, and the in-process fetch transport. Each provider package owns its own records, commands, protocol handler, and response construction. Providers depend only on core; the host coordinates them through public commands and explicit mappings.

Add provider operations in the owning package and test them through the real client/adapter. Add scenario transitions in `apps/simulator/src/run.ts`. New fault kinds should define their phase, matching fields, validation, response behavior, and durable consumption. Future delayed reads and transport delays must not use the commerce clock for HTTP deadlines. Independent connector schema contract tests remain necessary; simulator compatibility alone does not establish live-provider compatibility.

Run `pnpm test:simulator` for package tests, restart/isolation checks, installed-adapter integration tests, and Playwright control-panel checks. Playwright Chromium must be installed (`pnpm --filter @luma/api exec playwright install chromium`). Run repository checks with `pnpm check`. The simulator does not emulate OAuth, webhooks, or provider operations outside Luma's current adapter surface.
