# Adding an operational scenario

An operational scenario is an incident kind the simulator can cause, plus the Luma
detection and verification that should catch it. The panel, the scorecard and platform
tests share the same incident API, and Luma detects and verifies the issue through its
normal services. Stock sync drift (`inventory-drift`) is the working example.

## 1. Define the incident

Add the kind to `incidentKinds` in
[incidents.ts](../packages/simulator/core/src/incidents.ts) with a label and description,
a unit (per thousand orders or per simulated day), the Luma exception class that should
open a case (`null` while no detector exists) and the surface where people should see it.
Add a default rate to the presets in [presets.ts](../packages/simulator/core/src/presets.ts).

Start the incident where it happens in the merchant world (`apps/simulator/src/engine`):

- Stock incidents freeze the stock sync for one shop SKU, or stall it for every SKU of a
  shop and queue the changes until recovery
  ([stock.ts](../apps/simulator/src/engine/stock.ts)).
- Order incidents are planned when an order is placed and start at the step they affect,
  such as import, picking, shipment sync or refund
  ([orders.ts](../apps/simulator/src/engine/orders.ts),
  [fulfillment.ts](../apps/simulator/src/engine/fulfillment.ts)).
- Provider incidents set a timed service-health window
  ([advance.ts](../apps/simulator/src/engine/advance.ts)).

Record the incident with `openIncident` or `orderIncident`. Its resources must name the
provider records Luma's evidence will contain, such as global IDs, numeric JTL IDs or a
connection's instance; the scorecard matches on them. Keep provider protocol changes in
`packages/simulator/<provider>` and coordination in the engine.

Implement injection and recovery in
[engine/incidents.ts](../apps/simulator/src/engine/incidents.ts). Injection with a request
ID the incident already has returns the existing incident without another change.
Recovery repairs the cause the way the merchant would and is safe to repeat. Incidents
that end on their own, such as drift corrected through Luma, close when the condition
clears.

## 2. Wire real detection and verification

Registering an incident kind does not schedule detection. Reuse a suitable application
service or add a focused one in the owning package, with its rule in the domain.
[Scheduled detection](exception-detection.md#scheduled-detection) in
[detection-monitor.ts](../packages/resolution/src/application/detection-monitor.ts)
covers sync failures, linked stock and stuck fulfillment; the pilot runs it through
`pilot.detect()`. For a new rule, add a candidate read to its sources and a branch to its
verifier, or connect a separate service in [the pilot runtime](../tooling/pilot/runtime.mjs)
and the sync worker.
[inventory-monitor.ts](../packages/resolution/src/application/inventory-monitor.ts) and
[inventory.mjs](../tooling/simulator/inventory.mjs) show the pattern: an explicit canonical
SKU and location binding, complete provider pagination, confirmation of the exact mapped
records and current projections, then the existing exception rule.

Recovery changes provider state; verification performs an independent fresh read and
hands the evidence to the exception service. Missing records, provider failures,
incomplete results or stale evidence must leave the case open. Read case status from Luma;
the simulator stores only ground truth.

## 3. Check the controls and scorecard

The panel's **Incidents** tab lists every kind and injects it through the incident API, so
most kinds need no UI work; add panel controls only for what the generic form cannot
express. The scorecard reads Luma's cases through the pilot's simulator case endpoint,
which keeps the normal session, tenant and role checks. Make sure the expected class and
resource IDs match what your detector puts in the case's subject and evidence. Set a longer
detection window in [scorecard.ts](../apps/simulator/src/runtime/scorecard.ts) if the rule
needs it.

## 4. Test the journey

Extend [simulator.e2e.mjs](../apps/api/e2e/simulator.e2e.mjs) or use `setupSimulator(t)`
from [simulator-fixture.mjs](../apps/api/e2e/simulator-fixture.mjs) in a new suite. The
fixture provisions isolated Luma and simulator databases, a paused `test` run with `calm`
failures, installations, identity, the HTTP bridge and webhooks, with cleanup and failure
evidence. Advance time with `control advance` and run sync and checks with
`pilot.observe()`. Cover:

- a healthy baseline, injection, and a case backed by provider evidence;
- a retried injection without a second change or a duplicate active case;
- provider recovery while the case stays open until fresh verification;
- a failed or incomplete provider read preventing closure;
- resolution, recurrence, and an old recovery request leaving the new issue intact;
- the scorecard reporting the incident as detected.

Put engine behavior in [engine.test.ts](../apps/simulator/src/engine/engine.test.ts) and
rule edge cases in colocated unit tests; follow
[simulator.browser.mjs](../apps/api/e2e/simulator.browser.mjs) for the visible journey and
case link. A new test file or application package must be added to the explicit suite
selection in `tooling/dev/test-plan.mjs` and `tooling/dev/verify-feature.mjs`, and a new
journey mapped in `apps/api/e2e/journey-areas.mjs`, then run
`pnpm verify:feature simulator` (see [feature validation](development.md#feature-validation)).
