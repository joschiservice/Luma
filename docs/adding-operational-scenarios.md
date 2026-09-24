# Adding an operational scenario

Use inventory mismatch as the working example. The panel and platform tests use the same scenario HTTP API; Luma detects and verifies the issue through its normal services.

## 1. Define provider state and recovery

Start in [operational-scenarios.ts](../apps/simulator/src/operational-scenarios.ts). Inventory injection changes Shopify availability relative to JTL for a dedicated stock pool. Recovery reads current JTL availability and preserves Shopify reservations.

For a new issue, write down the affected resources, the provider mutation, what healthy state means, and which provider is authoritative. Use resources separate from autonomous merchant activity. Keep provider commands in `packages/simulator/<provider>` and coordination in the host.

Persist the scenario request ID and mutation together. Retrying injection must return the same scenario without applying the mutation again. Recovery must be safe to repeat, including when an old recovery request arrives after a new occurrence. Follow the existing restart and reset behavior in `run.ts` and `store.ts`.

## 2. Wire real detection and verification

Read [inventory.mjs](../tooling/simulator/inventory.mjs) for explicit canonical resource bindings and [inventory-monitor.ts](../packages/resolution/src/application/inventory-monitor.ts) for application behavior. Inventory completes provider pagination, confirms the exact mapped records and current projections, and evaluates the existing exception rule.

Reuse a suitable application service if one exists. Otherwise add a focused service in the owning application package and keep its rule in the domain. Connect it in [the pilot runtime](../tooling/pilot/runtime.mjs). Confirm which background collector invokes it; registering a scenario alone does not schedule detection.

Recovery changes provider state. Verification performs an independent fresh read and supplies evidence to the exception service. Missing records, provider failures, incomplete results, or stale evidence must leave the case open. Read case status from Luma rather than storing another lifecycle in the simulator.

## 3. Expose the controls

Follow the routes in [the simulator app](../apps/simulator/src/app.ts) and the authenticated bridge in [platform-client.mjs](../tooling/simulator/platform-client.mjs). Validate the scenario kind and request body. Keep application routes under the normal identity, tenant, origin, and role checks.

Add controls in `apps/simulator-web/src`. Show injection, provider recovery, and case resolution separately. Retain an injection request ID across uncertain retries, disable conflicting actions while a request is pending, and link to the real case.

## 4. Reuse the platform fixture

[simulator.e2e.mjs](../apps/api/e2e/simulator.e2e.mjs) uses `setupSimulator(t)` from [simulator-fixture.mjs](../apps/api/e2e/simulator-fixture.mjs). It provisions an isolated database, provider store, installations, identity, and HTTP bridge. Cleanup and failure evidence capture are already included.

Add assertions for the new behavior to that suite, or use the fixture in a new suite and include it in the focused validation command. Cover:

- Healthy baseline, injection, and a case backed by provider evidence.
- Retried injection without a second mutation or duplicate active case.
- Provider recovery while the case remains open until fresh verification.
- A failed or incomplete provider read preventing closure.
- Resolution, recurrence, and an old recovery request leaving the new issue intact.
- Durable restart and reset behavior where scenario state changes.

Put detailed rule and provider edge cases in colocated unit tests. Follow [simulator.browser.mjs](../apps/api/e2e/simulator.browser.mjs) for the visible journey and case link; reuse the fixture instead of creating another authentication or database setup.

## 5. Validate

Run `mise exec -- pnpm verify:feature simulator`. It covers the current inventory scenario and shared simulator behavior. If adding a new test file or application package, update the explicit suite selection in `tooling/dev/test.mjs` and `tooling/dev/verify-feature.mjs` as needed. Run `pnpm check` as the final repository gate. See [test tiers](development.md#feature-validation).
