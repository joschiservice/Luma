# Codebase map

Start with the row closest to the change. Follow imports from these entry points before searching the whole repository. Paths below are relative to the repository root.

| Change                                   | Entry points                                                                                                                                                                              | Tests                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Simulator provider behavior              | `packages/simulator/jtl/src/index.ts`, `packages/simulator/shopify/src/index.ts`; shared scheduling and transport in `packages/simulator/core/src/index.ts`                               | Colocated provider tests; `tooling/simulator/*.test.mjs` for installed adapters and persistence |
| Operational issue injection and recovery | `apps/simulator/src/operational-scenarios.ts`; HTTP routes in `apps/simulator/src/app.ts`; run lifecycle in `run.ts` and persistence in `store.ts`                                        | `apps/simulator/src/operational-scenarios.test.ts`, `run.test.ts`                               |
| Simulator controls                       | `apps/simulator-web/src/app.js`, `index.html`, `style.css`                                                                                                                                | Tooling panel tests; `apps/api/e2e/simulator.browser.mjs` for the platform journey              |
| Provider observations and mappings       | `tooling/simulator/observations.mjs` for coverage collection; `tooling/simulator/inventory.mjs` for the mapped inventory scenario; `packages/commerce-ingestion/src` for ingestion        | Commerce integration tests in `packages/application-runtime/src`; simulator E2E                 |
| Detection and independent verification   | `packages/resolution/src/application/inventory-monitor.ts`, `detection.ts`; rules in `packages/exceptions/src/domain/evaluate.ts`; case services in `packages/exceptions/src/application` | `inventory-monitor.test.ts`, exception domain tests, application-runtime integration tests      |
| Diagnosis and resolution                 | `packages/resolution/src/application/diagnosis.ts`, `playbook.ts`; actions in `packages/execution/src`                                                                                    | Colocated tests and application-runtime integration tests                                       |
| Application wiring and HTTP              | `packages/application-runtime/src/composition/application.ts`, `services.ts`; API bootstrap in `apps/api/src/composition/bootstrap.ts`                                                    | `packages/application-runtime/src/*.test.ts`, `apps/api/e2e/*.e2e.mjs`                          |
| Local simulator wiring                   | `tooling/simulator/cli.mjs`, `platform-client.mjs`, `tooling/pilot/runtime.mjs`                                                                                                           | `apps/api/e2e/simulator.e2e.mjs`                                                                |
| Isolated platform tests                  | `apps/api/e2e/simulator-fixture.mjs`, `tooling/simulator/e2e-environment.mjs`; database runner in `tooling/dev/test.mjs`                                                                  | Reuse `setupSimulator(t)` in API E2E and browser tests                                          |

## Workspace settings

Start at `packages/identity/src/application/settings.ts` for authorized edits and invitations,
`packages/identity/src/infrastructure/mail-delivery.ts` for durable delivery, and
`apps/web/src/features/settings/page.tsx` for Settings UI. Approval preferences feed
`packages/policies/src/application/policies.ts` and execution admission. Tests are
`apps/api/e2e/settings.e2e.mjs`, `settings.browser.mjs` and the Settings stories.
See [workspace settings](workspace-settings.md) for configuration and retry semantics.

## Operational issue flow

**Provider state → observation → detection → case → provider recovery → fresh verification**

The inventory scenario changes dedicated provider records. The inventory monitor reads them through installed capabilities, checks complete results and current projections, and passes evidence to the existing exception rule. A clear detection result allows a separate verification read; the exception service owns case closure and evidence requirements.

The local pilot composes this monitor in `tooling/pilot/runtime.mjs`. Its authenticated simulator application routes are local pilot wiring. The general observation collector records coverage and commerce observations; it does not automatically create a monitor for every exception type. Adding another scenario requires checking that its collection, detection, diagnosis, and verification are actually wired.

## Placement rules

- Put business decisions in domain files, use cases and ports in application files, and provider/database access in infrastructure files.
- Import other packages through their public exports. Composition roots wire services together; domain code must not depend on simulator or runtime composition.
- Keep provider protocol behavior in its simulator provider package. Coordinate providers in the simulator host.
- Reuse test identity and database provisioning. Assert real evidence and case transitions through application services or HTTP.

See [architecture decisions](architecture/README.md) for boundaries, [the scenario recipe](adding-operational-scenarios.md) for a worked example, and [development validation](development.md#feature-validation) for commands.

## Workspace apps and connectors

Start with `packages/app-host/src/application/contracts.ts` for app contracts and
`packages/app-host/src/application/installations.ts` for installation authorization.
`packages/app-host/src/infrastructure/installations.ts` persists tenant app state.
`packages/app-catalog/src/index.ts` composes apps and connections.
Provider adapters and UI live in `packages/apps/jtl/src` and `packages/apps/shopify/src`.
The app store and deferred loader are in `apps/web/src/features/apps`.

Tests: `packages/app-host/src/registry.test.ts`,
`packages/application-runtime/src/apps.integration.test.ts`, app-owned adapter tests,
`tooling/architecture/apps.test.mjs`, and `apps/api/e2e/connections.browser.mjs`.
See [Workspace apps](apps.md) for adding and removing an app.
