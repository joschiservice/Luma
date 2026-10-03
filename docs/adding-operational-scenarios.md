# Adding an operational scenario

An operational scenario is an incident kind the simulator can cause, plus the Luma detection and verification that should catch it. Use stock sync drift (`inventory-drift`) as the working example. The panel, the scorecard and platform tests share the same incident API, and Luma detects and verifies the issue through its normal services.

## 1. Define the incident

Add the kind to `incidentKinds` in [incidents.ts](../packages/simulator/core/src/incidents.ts). Give it:

- a label and description;
- a unit: per thousand orders or per simulated day;
- the Luma exception class that should open a case, or `null` while no detector exists;
- the surface where people should see it.

Add a default rate to the presets in [presets.ts](../packages/simulator/core/src/presets.ts).

Decide where the incident starts in the merchant world under `apps/simulator/src/engine`:

- Stock incidents freeze the stock sync for one shop SKU ([stock.ts](../apps/simulator/src/engine/stock.ts)).
- Order incidents are planned when an order is placed and start at the step they affect, such as import, picking, shipment sync or refund ([orders.ts](../apps/simulator/src/engine/orders.ts), [fulfillment.ts](../apps/simulator/src/engine/fulfillment.ts)).
- Provider incidents set a timed service-health window ([advance.ts](../apps/simulator/src/engine/advance.ts)).

Record the incident with `openIncident` or `orderIncident`. Its resources must name the provider records Luma's evidence will contain, such as global IDs, numeric JTL IDs or a connection's instance. The scorecard matches on them. Keep provider protocol changes in `packages/simulator/<provider>` and coordination in the engine.

Implement injection and recovery in [engine/incidents.ts](../apps/simulator/src/engine/incidents.ts):

- Injection with a request ID the incident already has returns the existing incident without another change.
- Recovery repairs the cause the way the merchant would and is safe to repeat.

Incidents that end on their own, such as drift corrected through Luma, close themselves when the condition clears.

## 2. Wire real detection and verification

Read [inventory.mjs](../tooling/simulator/inventory.mjs) for an explicit canonical SKU and location binding, and [inventory-monitor.ts](../packages/resolution/src/application/inventory-monitor.ts) for the application behavior. The monitor completes provider pagination, confirms the exact mapped records and current projections, and evaluates the existing exception rule.

Reuse a suitable application service if one exists. Otherwise add a focused service in the owning application package and keep its rule in the domain. Connect it in [the pilot runtime](../tooling/pilot/runtime.mjs) and confirm what schedules it. Registering an incident kind does not schedule detection.

Recovery changes provider state. Verification performs an independent fresh read and supplies evidence to the exception service. Missing records, provider failures, incomplete results or stale evidence must leave the case open. Read case status from Luma; the simulator stores only ground truth.

## 3. Check the controls and scorecard

The panel's **Incidents** tab lists every kind from `GET /api/profiles` and injects it through the incident API, so most kinds need no UI work. Add panel work only for controls the generic form cannot express.

The scorecard reads Luma's cases through `GET /v1/organizations/:id/simulator/cases` in the pilot, which keeps the normal session, tenant and role checks. Check that the expected class and resource IDs match what your detector puts in the case's subject and evidence. Set the detection window in [scorecard.ts](../apps/simulator/src/runtime/scorecard.ts) if the rule needs longer than the default.

## 4. Reuse the platform fixture

[simulator.e2e.mjs](../apps/api/e2e/simulator.e2e.mjs) uses `setupSimulator(t)` from [simulator-fixture.mjs](../apps/api/e2e/simulator-fixture.mjs). It provisions an isolated Luma database, a disposable simulator database, a paused `test` run with `calm` failures, installations, identity, the HTTP bridge and webhooks. Cleanup and failure evidence capture are included. Advance time with `control advance` and run sync and checks with `pilot.observe()`.

Add assertions for the new behavior to that suite, or use the fixture in a new suite and include it in the focused validation command. Cover:

- Healthy baseline, injection, and a case backed by provider evidence.
- Retried injection without a second change or duplicate active case.
- Provider recovery while the case remains open until fresh verification.
- A failed or incomplete provider read preventing closure.
- Resolution, recurrence, and an old recovery request leaving the new issue intact.
- The scorecard reporting the incident as detected.

Put detailed engine behavior in [engine.test.ts](../apps/simulator/src/engine/engine.test.ts) and rule edge cases in colocated unit tests. Follow [simulator.browser.mjs](../apps/api/e2e/simulator.browser.mjs) for the visible journey and case link.

## 5. Validate

Run `mise exec -- pnpm test:simulator` and `mise exec -- pnpm verify:feature simulator`. If you add a test file or application package, update the explicit suite selection in `tooling/dev/test-plan.mjs` and `tooling/dev/verify-feature.mjs` as needed. Run `pnpm check` as the final repository gate. See [test tiers](development.md#feature-validation).
