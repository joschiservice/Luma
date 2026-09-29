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

## Workspace shell, Home and personal layouts

The design system lives in `packages/ui/src/styles` (tokens, base, primitives,
workspace and issues) with brand primitives in
`packages/ui/src/components/primitives` (`brand`, `state`, `domain-icon`, `kbd`).
The shell is `apps/web/src/features/identity/shell.tsx` and `workspace-layout.tsx`;
destinations, `G` shortcuts and the command menu are in `workspace-destinations.ts`
and `workspace-search.tsx`. Home is `apps/web/src/features/home` (module catalog in
`preferences.ts`, modules in `modules.tsx`). Personal layouts and pins use
`apps/web/src/features/layout`, the `layout`/`saveLayout` settings routes in
`packages/identity/src/api/settings.ts` and migration `0033_workspace_layouts.sql`.
Tests are the Home and presentation unit tests, `settings.e2e.mjs`, the shell stories
and the browser journeys. See [shared frontend components](frontend-ui.md) and the
[design workflow](design-workflow.md).

## Documentation and contextual help

Start at `apps/web/src/features/help/context-help.tsx` for the navbar drawer,
`portal.tsx` in the same directory for the documentation portal, and
`apps/web/content/docs` for shared MDX articles. Routes select their guide through
`staticData.help`. See [contextual help](contextual-help.md) for authoring and
validation; browser tests are `apps/api/e2e/docs.browser.mjs` and
`apps/api/e2e/issues-help.browser.mjs`.

## Workspace settings

Start at `packages/identity/src/application/settings.ts` for authorized edits and invitations,
`packages/identity/src/infrastructure/mail-delivery.ts` for durable delivery, and
`apps/web/src/features/settings/page.tsx` for Settings UI. Approval preferences feed
`packages/policies/src/application/policies.ts` and execution admission. Tests are
`apps/api/e2e/settings.e2e.mjs`, `settings.browser.mjs` and the Settings stories.
Personal Appearance and Home & sidebar sections are in `apps/web/src/features/settings/personal.tsx`.
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

## Workflows

Start at `packages/workflows/src/domain/workflow.ts` for subject-based contracts,
`application/catalog.ts` for authorized catalog operations, and
`infrastructure/workflow-schema.ts` for typed authoring. Existing Resolution
execution and persistence adapters are owned by the same package. Resolution
retains diagnosis and case orchestration. The API contracts are in
`packages/api-contract/src/workflows.ts`; the UI is in
`apps/web/src/features/workflows`.

Tests: Workflow compiler tests, `apps/api/e2e/workflows.e2e.mjs`,
`playbooks.e2e.mjs` (both API paths), `playbooks.browser.mjs`, and existing execution
integration tests. See [Workflow model](workflows.md) and
[ADR-007](architecture/007-workflow-model.md).

General workflow starts enter through `packages/workflows/src/application/triggers.ts`.
Versioned signal checks live in `domain/trigger.ts`; tenant-isolated persistence
lives in `infrastructure/triggers.ts`. Migration `0025_workflow_triggers.sql`
owns durable scheduled starts, advanced by the workflow worker. The frontend
controls are in `apps/web/src/features/workflows/triggers.tsx`. Validate with
workflow unit tests and `apps/api/e2e/workflows.e2e.mjs`.

Multi-step process versions compile in `packages/workflows/src/infrastructure/process-schema.ts` and run through `application/process-runtime.ts`. `application/process-activities.ts` enforces an independent Action Admission call for each capability step. Temporal replay and waits live in `packages/workflow-temporal/src/process-workflow.ts`; step records use migration `0026_workflow_process_steps.sql`. The Workflow detail page shows the evidence timeline. See [Multi-step Workflow runtime](workflow-process-runtime.md) for adapter wiring and state ownership.

## Workflow authoring

Drafts, validation and publication start at
`packages/workflows/src/application/drafts.ts`; the rules live in
`infrastructure/process-schema.ts` (`checkProcessWorkflow`, `checkDraftContent`,
`parseDraftShape`) and `domain/vocabulary.ts` (vocabulary checks and step scopes).
The code view printer and parser are `domain/workflow-code.ts`; step summaries are
`domain/draft-presentation.ts`. Persistence is `infrastructure/drafts.ts` with
migration `0034_workflow_drafts.sql`. Templates are `application/templates.ts`
with sources in `packages/procurement/src/application/replenishment-workflow.ts`
and `packages/resolution/src/application/shipping-method-authoring.ts`, which also
contribute vocabulary. Contracts are `packages/api-contract/src/workflow-drafts.ts`;
routes are `packages/workflows/src/api/drafts.ts`, composed by `createDrafts` and
wired in `packages/application-runtime/src/composition/application.ts`.

The web gallery and editor are in `apps/web/src/features/workflows/authoring`
(`gallery.tsx`, `use-template.tsx`, `editor.tsx`, `builder.tsx`,
`step-forms.tsx`, `code-view.tsx`, `code-step-editor.tsx`, `publish.tsx`); the
code editor primitive is `packages/ui/src/components/primitives/code-editor.tsx`.

Tests: `process-schema.test.ts`, `vocabulary.test.ts`, `workflow-code.test.ts`,
`infrastructure/drafts.test.ts`, `draft-model.test.ts`, the
`Workflows/Authoring` and `UI/Code editor` stories,
`apps/api/e2e/workflow-drafts.e2e.mjs` and `workflow-authoring.browser.mjs`. See
[Workflow model](workflows.md#authoring-and-runtime-support).

Describing and refining drafts in natural language starts at
`packages/workflows/src/application/draft-generation.ts` (`createDraftGeneration`,
`generateDraft`). The vocabulary-limited output schema is
`domain/generation-schema.ts`; prompts, draft identity, removal of uninstalled
entries and Code Step checks are `domain/draft-generation.ts`; the step-level
diff is `domain/draft-diff.ts`. Output parsers are
`infrastructure/generation-output.ts`; records are `infrastructure/generations.ts`
with migration `0036_workflow_generations.sql`. Contracts are
`packages/api-contract/src/workflow-generation.ts`; routes are
`packages/workflows/src/api/generation.ts`, composed by `createDraftGenerations`.
`packages/application-runtime/src/composition/authoring.ts` decides availability
from the model routes. Tests: `domain/draft-generation.test.ts`,
`infrastructure/draft-generation.test.ts`, `composition/authoring.test.ts` and
`apps/api/e2e/workflow-generation.e2e.mjs`; the evaluation set is
`tooling/evaluation/authoring.mjs` (`pnpm evaluate:authoring`). See
[Describe a workflow](workflows.md#describe-a-workflow).

## Procurement

Start at `packages/procurement/src/domain/procurement.ts` for Supplier,
PurchaseOrder and line contracts and lifecycle rules.
`application/procurement.ts` owns authorized commands;
`infrastructure/store.ts` persists records and audit atomically. The API is in
`packages/api-contract/src/contracts/procurement.ts`, and the UI is in
`apps/web/src/features/procurement`. Migration `0027_procurement.sql` owns storage.

Tests: procurement domain tests, `apps/api/e2e/procurement.e2e.mjs` and
`procurement.browser.mjs`. See [Procurement records](procurement.md) for authority,
provenance, transitions and retry semantics.

## Replenishment workflow

Start at `packages/procurement/src/domain/replenishment.ts` for the bounded stock
rule and published process. Use cases are in
`packages/procurement/src/application/replenishment-workflow.ts`; composition and
worker recovery are in `composition/replenishment.ts` and
`replenishment-worker.ts`. Procurement owns rule persistence. Workflow detail
controls live in `apps/web/src/features/workflows/replenishment.tsx`.

Tests: `replenishment.e2e.mjs`, `replenishment.browser.mjs`, procurement rule tests
and Workflow compiler tests. See [Replenishment workflow](replenishment.md) for
scope, policy, recovery and the six simulator scenarios.

Sandboxed Code Steps: `packages/workflows/src/domain/code-step.ts`, `application/code-activity.ts`, and `infrastructure/code/`; native computation wiring in `infrastructure/code-processes.ts`. UI: `apps/web/src/features/workflows/code-steps.tsx`. Replay gate: `tooling/evaluation/code.mjs`. Runtime setup and contract: [Code Steps](code-steps.md). API/browser coverage: `apps/api/e2e/code-steps.*.mjs`.

Draft tests: cases, validation and prefill live in `packages/workflows/src/domain/draft-test.ts`; step results in `domain/draft-test-presentation.ts`. `application/draft-tests.ts` runs the real `runProcess` with example activities and optional sandboxed Code Steps. Storage is `infrastructure/draft-tests.ts` with migration `0035_workflow_draft_tests.sql`; routes are `api/draft-tests.ts` and `packages/api-contract/src/contracts/draft-tests.ts`. Adapters add scenarios through `TestScenarioSource`; replenishment's are in `packages/procurement/src/application/replenishment-scenarios.ts`. Tests: `draft-test.test.ts`, `infrastructure/draft-tests.test.ts`, `draft-test-code.test.ts`, `packages/application-runtime/src/composition/draft-tests.test.ts` and `apps/api/e2e/workflow-draft-tests.e2e.mjs`. See [Test a draft](workflows.md#test-a-draft).

## Shared record explorer

Record search and detail reads use `packages/resolution/src/application/records.ts` and
`infrastructure/record-explorer.ts`. The read model keeps current source snapshots
separate and resolves issue subjects through tenant-scoped source mappings. The
contract is `packages/api-contract/src/records.ts`; HTTP routing is
`packages/resolution/src/api/records.ts`. The web explorer and deep links are in
`apps/web/src/features/records`, with global search in
`apps/web/src/features/identity/workspace-search.tsx`.

Tests: `packages/application-runtime/src/commerce.integration.test.ts` and
`apps/api/e2e/records.browser.mjs`. Migration `0037_record_explorer_reads.sql`
grants the read model access to canonical identities and stock projections.

## Orders workspace

The order list and detail read model is `packages/resolution/src/infrastructure/orders.ts`,
with its port in `application/orders.ts` and progress, fulfillment and difference rules in
`domain/orders.ts`. Luma activity for an order uses the `subjects` filter in
`infrastructure/persistence/activity.ts`. The contract is `packages/api-contract/src/orders.ts`
and `contracts/orders.ts`; routes are `packages/resolution/src/api/orders.ts`. The web
feature is `apps/web/src/features/orders` (list `page.tsx`, detail `detail.tsx`, URL state
`data.ts`, wording `presentation.ts`). Live source context uses the app `record` slot;
Shopify's is `packages/apps/shopify/src/web/order-context.tsx`. Adapters fill the optional
order facts in their `infrastructure/adapter.ts`.

Tests: `domain/orders.test.ts`, `packages/application-runtime/src/orders.integration.test.ts`
(including metric parity and the large-import benchmark), the web `orders` unit tests,
the `Orders/Workspace` stories and `apps/api/e2e/orders.browser.mjs`. See
[Orders workspace](orders-workspace.md).

## Operational metrics

Start with `packages/orders/src/domain/metrics.ts` for versioned definitions and
`orders/src/infrastructure/metrics.ts` for canonical SQL. Resolution composes
coverage and inbox attention inside a shared read transaction in
`packages/resolution/src/infrastructure/metrics.ts`. API contracts live in
`packages/api-contract/src/metrics.ts`; the UI is
`apps/web/src/features/overview/order-metrics.tsx`, shown on the Insights page
(`insights.tsx`) and as an optional Home module.

Tests: `packages/application-runtime/src/commerce.integration.test.ts` and
`apps/api/e2e/metrics.browser.mjs`. See [Shared metrics](operational-metrics.md)
and [query measurements](operational-metrics-performance.md).

Live metrics use `0031_metric_notifications.sql`, the process listener in
`packages/application-runtime/src/infrastructure/metric-listener.ts`, and the
bounded SSE route in `packages/resolution/src/api/metric-events.ts`. The browser
subscription and recovery hook is `apps/web/src/features/overview/metrics-live.ts`.
See [Live operational metrics](live-operational-metrics.md); validation is
`metric-stream.e2e.mjs`, `metric-live.browser.mjs` and the stream unit tests.

Cross-domain metrics: domain definitions and summaries live in
`packages/exceptions/src/domain/metrics.ts`, `packages/procurement/src/domain/metrics.ts`
and `packages/connections/src/domain/metrics.ts`. Exceptions reuses the inbox SQL;
Procurement reads configured-source stocks and recorded POs. Snapshot composition is
`packages/resolution/src/infrastructure/operational-summary.ts`; typed v2 transport is
`packages/api-contract/src/operational-metrics.ts`. The grouped frontend is
`apps/web/src/features/overview/operational-metrics.tsx` and shares the live hook with
order v1. Migration 0032 extends invalidations. Tests: domain metric tests,
`operational-summary.test.ts`, `operational-metrics.e2e.mjs` and
`operational-metrics.browser.mjs`. See the shared metric and live metric guides.

Shopify operational records: `packages/apps/shopify/src/application/records.ts`
authorizes reads, `infrastructure/records.ts` queries scoped provider sections,
and `domain/records.ts` defines their coverage and source-link contracts.
`src/web/record-page.tsx` provides the Shopify app page; `src/web/records.tsx`
browses and follows records. Tests are the Shopify record reader, service and
route unit tests and `Apps/Shopify records` stories. See the
[Shopify app guide](../packages/apps/shopify/README.md#operational-records).

Shopify authorization and lifecycle webhooks live in
`packages/apps/shopify/src/infrastructure/oauth.ts`; compliance intake lives in
`infrastructure/privacy.ts` with migration `0038_shopify_privacy_requests.sql`.
The restricted operator command is `tooling/shopify/privacy.mjs`. See
[Shopify partner readiness](shopify-production.md) for portal settings, approval
gates, privacy fulfillment and smoke-test evidence. Tests are the OAuth
PostgreSQL suite, privacy unit tests and the connections browser journey.
