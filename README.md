# Luma

TypeScript modular monolith foundation. Node.js 24, pnpm 12, Turborepo.

## Start locally

```sh
nvm install
nvm use
corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm --filter @luma/ui exec playwright install chromium
# Complete docs/identity.md setup before starting the API.
pnpm dev
```

`packageManager` pins pnpm. If Corepack is unavailable, install the pinned version with `npm install --global pnpm@12.4.2`.

Web: http://localhost:3000. API: http://127.0.0.1:3001/health.
No secrets, database, or external services are needed. Stop both with Ctrl+C.

## Quality gates

Run these from the repository root, including on a clean checkout:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm check` runs all five. `pnpm format` applies formatting. CI runs the same gates after a frozen-lockfile install on Node 24. Typechecking generates the web route tree automatically; shared libraries build before dependent tasks. Tests use Vitest and fail if no tests are found.

## Backend end-to-end tests

`pnpm test:e2e` builds the API and its dependencies, then runs a dedicated Vitest suite with three process-level scenarios:

- Start the compiled API against a freshly migrated database; sign up, create an organization, check tenant access, restart, and sign out over HTTP.
- Run the migration command on an empty database and rerun it without changes. Reject a modified applied migration and roll back pending changes without losing existing data.
- Kill an execution worker with `SIGKILL` after its fixture provider commits an effect. Start a fresh worker and verify reconciliation, audit delivery, and no duplicate effect.

Use Node 24 and a disposable PostgreSQL 17 instance. `TEST_DATABASE_URL` must connect as an administrator that can create databases and roles. Each test creates a separate database and restricted runtime login, then removes them during cleanup. The migration role groups remain in the test cluster. External effects use a local, durable fixture ledger; no provider credentials are needed.

```sh
docker run --rm --detach --name luma-e2e-postgres \
  -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=luma_test_only -e POSTGRES_DB=luma_test postgres:17-alpine
# Wait until this reports that PostgreSQL accepts connections.
docker exec luma-e2e-postgres pg_isready -U postgres -d luma_test
TEST_DATABASE_URL=postgresql://postgres:luma_test_only@127.0.0.1:55432/luma_test pnpm test:e2e
docker stop luma-e2e-postgres
```

The command fails when `TEST_DATABASE_URL` is missing. CI runs it as a separate required step alongside the existing tests. `pnpm test` and `pnpm check` keep their existing scope; run `pnpm test:e2e` explicitly for these scenarios.

## Structure

| Path                         | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `apps/web`                   | TanStack Start + React; minimal server-rendered landing page |
| `apps/api`                   | Fastify + ts-rest HTTP server and public sample catalog      |
| `packages/api-contract`      | Shared schemas, typed client and generated OpenAPI           |
| `packages/ui`                | Reusable React components and Storybook component tests      |
| `packages/config`            | Validated server environment configuration                   |
| `packages/typescript-config` | Strict shared TypeScript settings for Node and React         |

Apps depend on packages through `workspace:*`; packages must not import apps. Keep domain features in explicit modules. Add shared packages only when they have a concrete consumer. Configuration packages are checked by their consuming builds and formatting/linting gates; runtime packages each have build, typecheck, and test scripts.

API build output is `apps/api/dist`; run with `pnpm --filter @luma/api start` after `pnpm build`. Shared config exports compiled JavaScript and declarations. Web builds produce `apps/web/dist/client` and `apps/web/dist/server`; a hosting adapter is a later deployment concern.

## Backend module boundaries

[ADR-001](docs/architecture/001-module-boundaries.md) defines module ownership, public interfaces, allowed dependencies, layering and event rules. Implement features under `apps/api/src/modules/<name>` as needed. `pnpm lint` enforces the boundary policy; `pnpm test:architecture` checks its regression fixtures and acyclic dependency map. Both run in CI through the existing gates.

## Canonical commerce model

[ADR-002](docs/architecture/002-canonical-commerce-model.md) defines the V0 entities, tenant-scoped identifiers, source snapshots, lifecycle fields and constraints for future Drizzle migrations. It covers JTL/Shopify comparison, raw payload retention, exception deduplication and the proposal → execution → verification → audit trail.

## Exception taxonomy

The [V0 exception taxonomy](docs/exception-taxonomy.md) defines four detection classes, evidence requirements, safe recovery and verification. Its versioned synthetic golden cases cover positive, negative and uncertain outcomes for the detection pipeline. The [detection guide](docs/exception-detection.md) covers ingestion, immutable evidence, tenant-scoped persistence, deduplication and resolution.

The [diagnosis guide](docs/exception-diagnosis.md) covers persisted evidence-backed investigations, revision invalidation, bounded rereads and optional Model Gateway reasoning.

## Tenant isolation and data residency

[ADR-003](docs/architecture/003-tenant-isolation-and-data-residency.md) defines trusted organization context, scoped repositories plus PostgreSQL RLS, EU-only V0 placement, regional service boundaries and the future dedicated database path. Its SQL/API conventions and acceptance checks govern LUMA-7/8 and later persistence adapters; the [identity implementation](docs/identity.md) provides authentication, organization routes and PostgreSQL isolation.

## Environment

Configure PostgreSQL and the required authentication settings using the [identity setup](docs/identity.md) before starting the API. Other overrides belong in the consuming app's `.env`; copy its `.env.example` first. API dev/start commands load that file; Vite loads web environment files. Real `.env` files are ignored. Document every new setting in the corresponding example, validate server settings at startup, and inject production secrets through the deployment environment.

API defaults: `HOST=127.0.0.1`, `PORT=3001`, `LOG_LEVEL=info`. Containers must explicitly set `HOST=0.0.0.0`. `PORT` must be 1–65535; `LOG_LEVEL` must be a supported Fastify/Pino level. `VITE_*` variables are public: never use them for credentials. Server configuration must not be imported into the web client.

Turborepo runs in strict environment mode. Add new runtime variable names to task `env` in `turbo.json`, especially variables used during builds so their values affect cache keys. Environment files already invalidate task caches. Builds and tests must not depend on production secrets.

## Contribution conventions

Branch from `main`: `feature/luma-<id>-<summary>`, `fix/luma-<id>-<summary>`, or `chore/luma-<id>-<summary>`. Use Conventional Commits, for example `chore(repo): bootstrap workspace`. PR titles should be concise and include the issue, for example `LUMA-3: Bootstrap monorepo`.

Link the Linear issue, describe behavior and validation, and keep PRs scoped. Run `pnpm check` before review. Commit `pnpm-lock.yaml` and the generated `apps/web/src/routeTree.gen.ts`; never edit the latter manually. Squash merge after review and passing CI. Once a GitHub remote exists, configure `Quality gates` as a required check on `main` and require review.

Implementation ADRs live in [docs/architecture](docs/architecture/README.md), the authoritative source reviewed and versioned with code. The [Linear decision register](https://linear.app/auren-labs/document/architecture-decision-register-305db9bed1de) contains summaries, issue links and repository references only; do not maintain full ADR copies there. Strategic product and business decisions remain in Notion. The web bootstrap follows [TanStack Start's setup guide](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch). The [HTTP API guide](docs/api.md) covers contracts, clients, errors and OpenAPI. The [identity guide](docs/identity.md) covers authentication, tenant guards, database roles and migrations. The [observability guide](docs/observability.md) covers Sentry, Langfuse, PostHog, correlation and data redaction.

## Model gateway

The [model gateway guide](docs/model-gateway.md) covers provider-independent generation, configured routes, structured output, tool proposals, data policy and Langfuse metadata. Model calls are disabled by default. Vercel routes support public/synthetic input; tenant input requires an approved EU adapter.

## Connector capabilities

The [connector SDK guide](docs/connectors.md) defines typed capability inputs/outputs, discovery, provider identities, errors, retry metadata, provenance hooks and the execution bridge. An in-memory provider demonstrates inventory reads and conditional writes through the same API/browser interface. The [Shopify adapter](docs/shopify.md) and [JTL-Wawi adapter](docs/jtl.md) supply read-only order, product, inventory and fulfillment observations.

## Safe execution

[ADR-004](docs/architecture/004-browser-runtime.md) proposes Browserbase for V0 browser execution, Playwright/CDP as the portability boundary and Anchor for BYOC/on-prem needs. It specifies the minimal runtime contract and validation required by the first browser-backed workflow.

The [execution guide](docs/execution.md) covers policy checks, approval, tenant-scoped idempotency, durable attempts, verification and append-only audit evidence. Workflow activities use the execution service for connector writes. The [Temporal runtime guide](docs/exception-workflows.md) covers worker startup, durable approvals, progress and recovery.

## UI workshop

```sh
pnpm storybook        # http://localhost:6006
pnpm test:ui          # stories + interactions + accessibility in headless Chromium
pnpm build:storybook  # static workshop in packages/ui/storybook-static
```

`pnpm test` includes component tests; `pnpm build` includes the workshop. Install Chromium once using the setup command above (CI installs it with system dependencies). Storybook uses the React/Vite renderer without the TanStack Start server plugin, so no API, secrets or running application are needed. Only the Vitest and accessibility addons are installed; accessibility violations fail tests.

Reusable components and their `*.stories.tsx` files live together in `packages/ui/src/components`. Import components in the web app through explicit package exports, for example `import { Button } from '@luma/ui/button'`. This internal package exports React/TypeScript source for Vite to bundle and typecheck; its build also emits declarations. Import `@luma/ui/styles.css` once in each host and enable the Tailwind Vite plugin. The app and workshop share the same Luma tokens and component styles.

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
