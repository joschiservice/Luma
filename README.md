# Luma

TypeScript modular monolith foundation. Node.js 24, pnpm 12, Turborepo.

## Start locally

Install [mise](https://mise.jdx.dev/getting-started.html) and start a Docker-compatible container runtime with Compose v2, then:

```sh
mise trust
mise install
mise run setup
mise run dev
```

With mise activated in your shell, the last two commands are `pnpm run setup` and `pnpm dev`.
Setup installs dependencies and Chromium, starts PostgreSQL 17, applies migrations,
provisions restricted database logins, and seeds a demo workspace. No manual SQL,
environment edits, or provider credentials are needed. Node and pnpm are pinned in
`mise.toml`; `.nvmrc` and `packageManager` retain support for existing tooling.

The command prints this checkout's web and API URLs. Demo credentials are stored
in `.luma/demo.json`. Ctrl+C stops app processes; `pnpm dev:down` stops local
services and preserves database data. Each worktree has its own ports, credentials,
Compose project and volumes. See [local development](docs/development.md) for
workflow workers, configuration, diagnostics, and manually managed services.

To erase this worktree's local database and restore the demo data, stop the app
and worker processes, then run `pnpm db:reset`. This reapplies all migrations and
prints the demo login details.

To browse and edit this checkout's local database, run `pnpm db:studio` after
setup and open [Drizzle Studio](https://local.drizzle.studio). The command starts
PostgreSQL if needed and uses this checkout's saved connection details. Studio
connects as the local database administrator, so you can view data across all
organizations. Edits are saved directly to the local database. Ctrl+C stops Studio.

Safari and Brave require HTTPS for Studio's local connection. On macOS, run
`brew install mkcert` and `mkcert -install` once, then restart `pnpm db:studio`.
The certificate installation may request your macOS administrator password.
Drizzle Studio detects mkcert and generates its localhost certificate automatically.

## Synthetic pilot

Run `pnpm pilot:seed`, then `pnpm pilot` and `pnpm pilot:worker` in separate terminals
for fixture-backed external systems with the real database and workflow stack.
See the [pilot guide](docs/pilot-environment.md) for scenario reset, credentials,
approval, verification and worker crash recovery.

## Quality gates

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:browser
```

`pnpm check` runs formatting, lint, typechecking, tests and builds. `pnpm test:full`
runs all gates including backend and browser E2E with one disposable PostgreSQL 17
container. CI runs the same gates in parallel jobs, with browser E2E split across
two shards. The required `Quality gates` check passes only when every job succeeds.
Install Chromium first with `pnpm run setup`
(on Linux CI, use Playwright's `--with-deps` option).

`pnpm test`, `pnpm test:e2e` and `pnpm test:browser` automatically start PostgreSQL
through Testcontainers and remove it afterwards. If `TEST_DATABASE_URL` is set,
they use that disposable test cluster instead. The supplied login must be able to
create databases and roles. Tests create isolated databases and restricted runtime
logins; they never use the development database by default. External provider
credentials are not needed. Container startup failures fail the command.

`pnpm test:local` runs the existing test suites without provisioning services;
database integration suites skip when `TEST_DATABASE_URL` is absent. Use it for
an explicitly limited, container-free check, not as a substitute for `pnpm test`.
`pnpm test:ui` and `pnpm storybook` also work independently of the API.

Backend E2E covers HTTP identity lifecycle across restarts, migration checksum and
rollback behavior, and execution-worker crash recovery. Browser E2E starts the
real API and Vite app on available ports and exercises identity and connection
flows. Shared packages rebuild while developing; typechecking generates the web
route tree automatically.

## Structure

| Path                         | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `apps/web`                   | TanStack Start + React; minimal server-rendered landing page |
| `apps/api`                   | Fastify + ts-rest HTTP server and public sample catalog      |
| `packages/api-contract`      | Shared schemas, typed client and generated OpenAPI           |
| `packages/connectors/*`      | Shopify/JTL protocols and shared transport failure handling  |
| `packages/ui`                | Reusable React components and Storybook component tests      |
| `packages/config`            | Validated server environment configuration                   |
| `packages/typescript-config` | Strict shared TypeScript settings for Node and React         |

Apps depend on packages through `workspace:*`; packages must not import apps. Keep domain features in explicit modules. Add shared packages only when they have a concrete consumer. Configuration packages are checked by their consuming builds and formatting/linting gates; runtime packages each have build, typecheck, and test scripts.

API build output is `apps/api/dist`; run with `pnpm --filter @luma/api start` after `pnpm build`. Shared config exports compiled JavaScript and declarations. Web builds produce `apps/web/dist/client` and `apps/web/dist/server`; a hosting adapter is a later deployment concern.

## Backend module boundaries

[ADR-001](docs/architecture/001-module-boundaries.md) defines module ownership, public interfaces, allowed dependencies, layering and event rules. Implement features in their owning `packages/<domain>` package. [ADR-005](docs/architecture/005-domain-packages-and-runtimes.md) defines the package layout, shared runtime, and separate API/worker processes. `pnpm lint` enforces the boundary policy; `pnpm test:architecture` checks its regression fixtures and acyclic dependency map. Both run in CI through the existing gates.

## Canonical commerce model

[ADR-002](docs/architecture/002-canonical-commerce-model.md) defines the V0 entities, tenant-scoped identifiers, source snapshots, lifecycle fields and constraints for future Drizzle migrations. It covers JTL/Shopify comparison, raw payload retention, exception deduplication and the proposal → execution → verification → audit trail.

The [commerce projection guide](docs/commerce-projections.md) covers persisted source
observations, explicit reconciliation mappings, canonical snapshots and replay.

## Exception taxonomy

The [V0 exception taxonomy](docs/exception-taxonomy.md) defines four detection classes, evidence requirements, safe recovery and verification. Its versioned synthetic golden cases cover positive, negative and uncertain outcomes for the detection pipeline. The [detection guide](docs/exception-detection.md) covers ingestion, immutable evidence, tenant-scoped persistence, deduplication and resolution.

The [diagnosis guide](docs/exception-diagnosis.md) covers persisted evidence-backed investigations, revision invalidation, bounded rereads and optional Model Gateway reasoning.

## Tenant isolation and data residency

[ADR-003](docs/architecture/003-tenant-isolation-and-data-residency.md) defines trusted organization context, scoped repositories plus PostgreSQL RLS, EU-only V0 placement, regional service boundaries and the future dedicated database path. Its SQL/API conventions and acceptance checks govern LUMA-7/8 and later persistence adapters; the [identity implementation](docs/identity.md) provides authentication, organization routes and PostgreSQL isolation.

## Environment

`pnpm run setup` configures the managed local environment in `.luma/`. For existing PostgreSQL installations, follow the [identity setup](docs/identity.md) and run `pnpm dev:manual`. Other overrides belong in the consuming app's `.env`; copy its `.env.example` first. API dev/start commands load that file; Vite loads web environment files. Real `.env` files are ignored. Document every new setting in the corresponding example, validate server settings at startup, and inject production secrets through the deployment environment.

API defaults: `HOST=127.0.0.1`, `PORT=3001`, `LOG_LEVEL=info`. Containers must explicitly set `HOST=0.0.0.0`. `PORT` must be 0–65535 (0 requests an available port); `LOG_LEVEL` must be a supported Fastify/Pino level. `VITE_*` variables are public: never use them for credentials. Server configuration must not be imported into the web client.

Turborepo runs in strict environment mode. Add new runtime variable names to task `env` in `turbo.json`, especially variables used during builds so their values affect cache keys. Environment files already invalidate task caches. Builds and tests must not depend on production secrets.

## Contribution conventions

Run `pnpm lint:fix` followed by `pnpm format` to apply style fixes. ESLint uses the
official [typescript-eslint recommended and stylistic presets](https://typescript-eslint.io/users/configs/),
with React Hooks and module-boundary checks. Empty test and Storybook stubs are
allowed; intentional empty production callbacks need an explanatory comment.
Both interfaces and type aliases are allowed because database row types rely on
the implicit index signatures of type aliases.
Prettier handles formatting. ESLint sorts and checks imports, requires spacing
after imports, around declarations, and before returns, and requires descriptions
on exported functions in application, package, and tooling source. Documentation
is written by the author; autofix never inserts empty doc comments. Tests,
stories, fixtures, and generated route declarations are exempt from documentation
requirements. The existing CI lint gate enforces these rules; `pnpm test:style`
checks the configuration and its compatibility with Prettier.

Give exported functions and callable contracts short doc comments describing what
callers need to know: behavior, input requirements, side effects, and relevant
failure modes. Keep business rules in domain files, use cases and ports in
application files, and database or provider access in infrastructure files.
Colocate focused unit tests with the behavior they verify.

Shared composition lives in `packages/application-runtime/src/composition`.
`apps/api` starts HTTP and `apps/worker` starts Temporal workers. Domain packages
expose contracts, construction functions and HTTP adapters through separate exports.
The pilot and simulator use the same typed service graph with explicit execution
and provider dependencies. See [ADR-005](docs/architecture/005-domain-packages-and-runtimes.md).

Branch from `main`: `feat/LUMA-<id>-<short-description>`. Use Conventional Commits, for example `chore(repo): bootstrap workspace`. PR titles should be concise and include the issue, for example `LUMA-3: Bootstrap monorepo`.

Link the Linear issue, describe behavior and validation, and keep PRs scoped. Run `pnpm check` before review. Commit `pnpm-lock.yaml` and the generated `apps/web/src/routeTree.gen.ts`; never edit the latter manually. Squash merge after review and passing CI. Once a GitHub remote exists, configure `Quality gates` as a required check on `main` and require review.

Implementation ADRs live in [docs/architecture](docs/architecture/README.md), the authoritative source reviewed and versioned with code. The [Linear decision register](https://linear.app/auren-labs/document/architecture-decision-register-305db9bed1de) contains summaries, issue links and repository references only; do not maintain full ADR copies there. Strategic product and business decisions remain in Notion. The web bootstrap follows [TanStack Start's setup guide](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch). The [HTTP API guide](docs/api.md) covers contracts, clients, errors and OpenAPI. The [identity guide](docs/identity.md) covers authentication, tenant guards, database roles and migrations. The [observability guide](docs/observability.md) covers Sentry, Langfuse, PostHog, correlation and data redaction.

## Operations overview

The [operations overview guide](docs/operations-overview.md) defines summary windows, connection freshness, metric availability and refresh behavior.

## Case inbox

The [case inbox guide](docs/case-inbox.md) covers attention views, filters, persisted investigations, evidence freshness and the read-only API.

## Model gateway

The [model gateway guide](docs/model-gateway.md) covers provider-independent generation, configured routes, structured output, tool proposals, data policy and Langfuse metadata. Model calls are disabled by default. Vercel routes support public/synthetic input; tenant input requires an approved EU adapter.

## Connector capabilities

The [connector SDK guide](docs/connectors.md) defines typed capability inputs/outputs, discovery, provider identities, errors, retry metadata, provenance hooks and the execution bridge. An in-memory provider demonstrates inventory reads and conditional writes through the same API/browser interface. The [Shopify adapter](docs/shopify.md) and [JTL-Wawi adapter](docs/jtl.md) supply read-only order, product, inventory and fulfillment observations.

## Safe execution

[ADR-004](docs/architecture/004-browser-runtime.md) proposes Browserbase for V0 browser execution, Playwright/CDP as the portability boundary and Anchor for BYOC/on-prem needs. It specifies the minimal runtime contract and validation required by the first browser-backed workflow.

The [execution guide](docs/execution.md) covers policy checks, approval, tenant-scoped idempotency, durable attempts, verification and append-only audit evidence. Workflow activities use the execution service for connector writes. The [Temporal runtime guide](docs/exception-workflows.md) covers worker startup, durable approvals, progress and recovery.

The [Resolution Playbook guide](docs/resolution-playbooks.md) covers typed authoring,
immutable versions, scoped activation, evidence snapshots and the pilot correction.

The [resolution learning guide](docs/resolution-learning.md) covers structured
incident histories, human repairs, playbook reuse, verification attempts and
exports for outcome evaluation.

## UI workshop

```sh
pnpm storybook        # http://localhost:6006
pnpm test:ui          # stories + interactions + accessibility in headless Chromium
pnpm build:storybook  # static workshop in packages/ui/storybook-static
```

`pnpm test` includes component tests; `pnpm build` includes the workshop. Install Chromium once using the setup command above (CI installs it with system dependencies). Storybook uses the React/Vite renderer without the TanStack Start server plugin, so no API, secrets or running application are needed. Only the Vitest and accessibility addons are installed; accessibility violations fail tests.

Reusable components and their `*.stories.tsx` files live together in `packages/ui/src/components`, grouped into `primitives`, `issues`, `overview`, and `workspace`. Import components in the web app through explicit package exports, for example `import { Button } from '@luma/ui/components/primitives/button'`. This internal package exports React/TypeScript source for Vite to bundle and typecheck; its build also emits declarations. Import `@luma/ui/styles.css` once in each host and enable the Tailwind Vite plugin. The app and workshop share the same Luma tokens and component styles.

Use `button.stories.tsx` as the example: default, keyboard, disabled and composed pending states share the real Base UI component. Input, dialog and spinner stories cover the other starter primitives. Add named stories for meaningful UI states and `play` assertions for important interactions. Keep fixtures deterministic and pass state through props. Keep data fetching, auth, mutations and business decisions in the application; stories must not reimplement them. Add a local decorator only when a component needs a provider (for example an in-memory TanStack router). Do not wrap every story in the application root.

Automated accessibility checks complement keyboard and manual review; they do not establish full accessibility compliance. The integration follows the [Storybook Vitest guide](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon) and [accessibility test guidance](https://storybook.js.org/docs/writing-tests/accessibility-testing).

See [UI package conventions](packages/ui/README.md) for tokens, Base UI composition, adding components and future Tauri/React consumers.

## Forms and state

| State                                         | Owner                           |
| --------------------------------------------- | ------------------------------- |
| Draft values, touched fields and validation   | TanStack Form                   |
| Server data, requests and mutation results    | TanStack Query                  |
| Shareable filters, sorting and view selection | TanStack Router search params   |
| Ephemeral UI state                            | React `useState` / `useReducer` |

Use Zod schemas directly with Standard Schema consumers: Form's `validators` and Router's `validateSearch`. Form validates without applying schema transforms, so parse again on submission to obtain normalized output. Validate unknown responses at the I/O boundary; the server must independently validate requests. Keep schemas beside their feature until sharing has a real consumer.

The web router creates one QueryClient per router/request and uses TanStack's SSR Query integration for hydration and its provider. Never make a server QueryClient a module singleton. Keep query keys, mutation functions and cache invalidation beside their features.

For URL state, define `validateSearch` on the route, read `Route.useSearch()`, and update with `navigate({ search: ... })`. Do not mirror search values into a separate store. `apps/web/src/lib/search-params.test.ts` demonstrates direct Zod validation, defaults and parsed URL values with a memory router.

Use `ts-pattern` with `.exhaustive()` for domain discriminated unions. There is no global state library API or custom form framework. TanStack Form internally depends on TanStack Store; Luma does not depend on it directly or create stores.

`packages/ui/src/examples/contact-form.stories.tsx` demonstrates validated submission with the shared Base UI primitives, a local Query provider and injected fake I/O. It covers invalid, pending, conflict, failure and malformed-response states without adding a product API. Form, Query, Zod and ts-pattern are development dependencies of the workshop and runtime dependencies of the web host; shared primitives stay independent of them.

### Stateful commerce simulator

Run `mise exec -- pnpm simulator` to start persistent JTL and Shopify simulations, their control panel, and the Luma pilot API/worker stack. See [the simulator guide](docs/simulator.md) for provisioning, scenarios, fault injection, restart behavior, and tests.

## Local performance diagnostics

Run `mise exec -- pnpm dev:observe` to start the app, worker, and local Grafana stack. The terminal prints the dashboard address. See [local observability](docs/local-observability.md) for traces, database queries, CPU profiles, and verification commands.

The [Workspace Activity guide](docs/workspace-activity.md) describes searchable action history,
immutable event provenance, pagination and historical coverage.

Playbook releases can be checked with `pnpm evaluate:playbook`. See the [evaluation harness](tooling/evaluation/README.md) for historical capture, fixtures and reports.
