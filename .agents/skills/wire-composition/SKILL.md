---
name: wire-composition
description: Wire a domain service, background pass or HTTP route area through Luma's composition root so the API, workflow worker, commerce sync worker, pilot and simulator all compose it alike - service factories, app-host options, resource ownership and shutdown, route slices, the architecture rules and tests. Use when a process must construct a new or changed service, when one owner starts depending on another, when adding an HTTP route area or background pass, or when behavior differs between runtimes.
---

# Wiring through the composition root

`@luma/application-runtime` and the process entry points are the composition root: the only
code that constructs domain services and connects them. Composition wires; it never decides.
Each process builds its services through its own path, so a service wired into one path can be
missing, or composed differently, in another. Read these first:

- [ADR-005](../../../docs/architecture/005-domain-packages-and-runtimes.md): public interfaces,
  composition and capabilities, resource scopes and persistence ownership.
- [`packages/application-runtime/AGENTS.md`](../../../packages/application-runtime/AGENTS.md):
  local rules for composition, migrations and integration tests.
- The wiring conventions in the [codebase map](../../../docs/codebase-map.md#conventions).

## Runtime paths

| Path            | Entry                                                                      | How it composes services                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API             | `apps/api/src/index.ts`, `buildRuntimeApp` in `composition/runtime-app.ts` | `createApplicationServices` with `applicationOptionsFor` (provider runtimes only with connection settings); execution enabled only with a workflow client; `buildApp` serves `application.http` |
| Workflow worker | `apps/worker/src/index.ts`, `@luma/application-runtime/worker`             | `createApplicationServices` with enabled execution and no model gateway                                                                                                                         |
| Commerce sync   | `apps/worker/src/sync.ts`, `@luma/application-runtime/sync`                | the sync loop plus mailbox, supplier follow-up, return follow-up, detection and retention workers; each worker composes its own services                                                        |
| Pilot           | `tooling/pilot/runtime.mjs`, started as `api` or `worker` role             | `createApplicationServices` with its own effect registry and verifier; the worker role runs its own follow-up passes                                                                            |
| Simulator       | `tooling/simulator/cli.mjs` starts the pilot with a simulator manifest     | the pilot path with simulated provider runtimes                                                                                                                                                 |

Seeding (`tooling/pilot/seed.mjs`) and some journeys also call `createApplicationServices`.
Find every caller with `rg "createApplicationServices\(|applicationOptionsFor\(" apps packages tooling`.
The staff API composes `@luma/staff` on its own and does not use this graph.

## 1. Keep the rule in the owner

Put business rules, ports and persistence in the owning package. Export constructors from its
`/composition` entry, contracts and types from its root, and routes from `/http`. A
composition function takes the owner's ports and connects them to other owners' public
services; if it needs an `if` about business state, that decision belongs in the owner.

## 2. Wire the service once

- A tenant service that more than one process uses belongs in `createApplicationServices`.
  Wire an area in a focused factory module in `src/composition` that `createApplicationServices`
  calls, returning the area's services. Owners that refer to each other (through `safety`,
  combined effects and eligibility) are connected with closures that run only when requests
  arrive; keep that cycle where its order stays visible.
- Return the service on `ApplicationServices`: top level for workers, `http` for routes. Both
  the API and the pilot spread `application.http` into `buildApp`.
- An input that comes from the app host (installed apps' decisions, workflows and evidence,
  provider runtimes, model routes) goes into `applicationOptionsFor`, so every process derives
  it the same way. Only process-specific inputs (execution, workflow transport, desk reader,
  stock refresh, timing) stay with each runtime.
- Make optional inputs fail closed and say on the option what its absence means, such as
  "without it, orders cannot be sent from Luma". Never default to a permissive reader,
  verifier or effect registry.
- A provider write needs its effect family resolved in every runtime that can send or
  reconcile it; see the [add-governed-action](../add-governed-action/SKILL.md) skill.

## 3. Own resources

`createApplicationServices` opens nothing. Anything that opens a pool, client, listener or
timer belongs to a runtime builder:

- Register its close with `resources.add` immediately after acquiring it. The scope closes in
  reverse order, attempts every close and shares repeated calls. If initialization fails, close
  the scope before rethrowing.
- A background pass returns `run`, `shutdown` and `close`; add it to the commerce sync loops and
  its close to the scope, and stop its timers before the pools it uses close.
- Keep pools separate across privilege boundaries. Each process uses only its own login, and
  identity and workflow credentials stay apart (see
  [database roles](../../../docs/development.md#database-roles)). Cross-tenant discovery goes through a restricted function that
  returns routing identities; each step then resolves its tenant context.
- A new runtime setting is validated in `@luma/config`, documented in the relevant
  `.env.example` and added to the Turbo task environment.

## 4. Add an HTTP route area

1. Add schemas in `packages/api-contract/src/<feature>.ts` and routes in its `contracts`, join the
   area to `domains/<package>.ts`, and run `pnpm --filter @luma/api-contract generate:index`.
   See the [HTTP API](../../../docs/api.md) guide.
2. Implement the routes in the owner's `/http` export, taking its services as parameters.
3. Add or extend `src/composition/features/<package>.ts`, which builds the package's route group
   from `AppDependencies`. A missing service must answer as unavailable. Spread the slice into
   the router in `http-app.ts` and keep keys sorted; the features test requires exactly one
   slice per contract area.

## 5. Check every path

For each row in the table, confirm the process gets the service with the same options, or
deliberately does without it and reports it unavailable. A background pass needs wiring in the
commerce sync composition and in the pilot worker role. Compare against an existing service
of the same kind before adding a new pattern.

## 6. Architecture rules

- Only `packages/application-runtime` and the process entry files named in the rule in
  `tooling/architecture/eslint-plugin.mjs` may import domain packages, and only through their
  entry points: the root, `/composition`, `/http` and `/adapters`. Domain packages never import
  the runtime or apps.
- Package-to-package directions live in `tooling/architecture/policy.mjs`; keep ADR-001's table
  in sync when they change. Add new dependencies to the importing package's `package.json`.

## 7. Tests

- Unit-test a composition module over in-memory ports where it connects owners in a
  non-obvious way, and keep the features test passing for route areas.
- Database integration tests in `packages/application-runtime` (with `createMigratedDatabase`)
  for cross-owner reads, transactions and restricted roles.
- Resource tests for cleanup when initialization fails and for shutdown order.
- Journeys for each runtime the change reaches, including worker restarts for background
  passes; map new source in `apps/api/e2e/journey-areas.mjs`.
- `pnpm lint` and `pnpm test:architecture` for the import rules.

Finish with the [verify-change](../verify-change/SKILL.md) skill.
