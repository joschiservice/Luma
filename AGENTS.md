# Luma

Luma helps commerce teams detect operational issues, investigate their causes, and resolve them through policy-controlled actions and workflows. Provider observations, canonical records, approvals, execution and fresh verification form one traceable path.

The codebase is a TypeScript modular monolith: a Fastify/ts-rest API, a TanStack Start/React web app, separate Temporal workers, and PostgreSQL persistence. Domain packages share explicit contracts and are assembled by application runtime composition.

## What matters

### Evidence before conclusions

Keep provider observations, canonical state and inferred conclusions distinct. Incomplete reads, stale evidence and uncertain writes are meaningful states. A successful provider action does not prove an issue is resolved; closure requires independent, fresh verification.

### Controlled actions

Preserve authorization, policy admission, approval, idempotency and audit behavior when changing execution. Retries and worker restarts must not duplicate external effects. Model output proposes work through the same validated contracts and controls as other callers.

### Tenant isolation

Carry trusted tenant context through application services and persistence. Preserve scoped queries, PostgreSQL RLS and restricted runtime roles. Keep credentials and tenant data out of public client configuration and telemetry payloads. Follow the existing data-residency and model-processing policies.

### Clear, responsive operations

People need to distinguish what needs attention, what Luma is doing, and what has been verified. Keep loading, stale, unavailable, failed and empty states accurate. Consider query cost, payload size, live subscriptions and rendering work when changing busy operational views. Measure performance claims.

## Working approach

Understand the constraint, then choose the smallest model that makes the correct behavior clear. Prefer simple, explicit code and predictable interfaces. Do not preserve unnecessary complexity or introduce abstractions and dependencies without a concrete use.

Keep changes scoped. Follow established patterns unless there is a clear reason to change them. The developer's explicit task and preferences take precedence over these defaults.

Use the [codebase map](docs/codebase-map.md) to find the owning package, then search and follow imports from there. Read the feature's guide in the [docs index](docs/README.md) before changing its rules. Use the [operational scenario recipe](docs/adding-operational-scenarios.md) when adding detection and recovery scenarios.

## Shared vocabulary

- **Workspace / tenant:** an organization and its isolated data, memberships and configuration.
- **Provider:** an external commerce system, such as Shopify or JTL.
- **Connection:** a configured installation through which Luma accesses provider capabilities.
- **Observation:** a provider read with source identity, freshness and completeness information.
- **Canonical record:** Luma's commerce representation, linked to provider records through explicit mappings.
- **Issue / case:** an operational problem shown to the user, with persisted evidence and a resolution lifecycle.
- **Workflow:** a versioned process with activation, runs and execution provenance.
- **Verification:** an independent read that establishes whether the expected outcome occurred.
- **Pilot / simulator:** local synthetic provider environments that exercise the real application services and execution path.

## Follow the whole behavior

Before calling a feature complete, check the paths affected by the change:

- **Contracts:** update the shared API schema, server behavior and consuming clients together.
- **Entry points:** check relevant pages, detail views, Home modules, search, shortcuts and contextual help.
- **Runtime paths:** API, background worker, pilot and simulator share services; a fix in one composition path may leave others unchanged.
- **Providers:** decide how a capability change affects each installed adapter and its simulator.
- **Lifecycle:** cover retries, cancellation or reversal where supported, restart, recurrence and uncertain outcomes.
- **Authority:** test tenant boundaries, role restrictions and approval changes where they affect the behavior.
- **Presentation:** review light and dark themes, narrow layouts, keyboard use and meaningful status labels for UI changes.

## Where code lives

- `apps/web` — product routes, feature UI and public MDX user guides in `content/docs`.
- `apps/api` and `apps/worker` — HTTP and Temporal process entry points, configuration and lifecycle.
- `packages/<domain>` — business rules, application services, ports and persistence owned by each domain.
- `packages/application-runtime` — shared service composition, resource ownership and ordered database migrations.
- `packages/api-contract` — HTTP schemas, typed client and OpenAPI generation.
- `packages/platform` and `packages/config` — shared technical infrastructure and validated server configuration.
- `packages/apps/*`, `packages/app-host` and `packages/app-catalog` — workspace apps, installation contracts and registration.
- `packages/connectors/*` — provider protocols and shared transport behavior.
- `packages/workflow-temporal` — durable workflow implementation and Temporal adapters.
- `packages/ui` — shared components, semantic design tokens, stories and component tests.
- `apps/simulator`, `apps/simulator-web`, `packages/simulator/*` and `tooling/pilot` — synthetic provider behavior and operational scenarios.
- `tooling` — development, validation, evaluation and observability commands.

## Architecture and code quality

- Keep business rules in domain files, use cases and ports in application files, and database/provider access in infrastructure files. Composition roots wire dependencies; they do not own business rules.
- Import other packages through their public exports. Packages must not import apps. Respect the package and layer policy enforced by ESLint and architecture tests.
- Each domain owns writes to its tables. Keep cross-domain reads in deliberate query adapters. Preserve transaction boundaries when composing owner operations.
- Use the shared migration runner. Add migrations without rewriting applied filenames or checksums. Runtime roles must not acquire migration privileges.
- Keep functions, modules and components focused. Use clear names, avoid hidden side effects and colocate tests with the behavior they verify.
- Preserve strict TypeScript checks. Prefer inference where it is clear; make public contracts explicit where callers need them. Do not silence type errors with `any` or unchecked assertions.
- Add short doc comments to exported functions and callable contracts. Explain behavior, input requirements, side effects and relevant failure modes. Do not repeat types or add empty documentation tags.
- Keep imports together at the top and separate logical steps with blank lines. Run `pnpm lint:fix` and `pnpm format` for code style fixes; review the resulting diff.

See the [architecture decisions](docs/architecture/README.md), especially [domain packages and composition](docs/architecture/005-domain-packages-and-runtimes.md), for ownership and constraints.

## UI conventions

Use existing `@luma/ui` components first. Add a shadcn component or a focused custom component when needed. Shared components own their appearance; features own layout and domain presentation. Use variants for reusable appearance changes instead of overriding shared surfaces, colors or typography in page CSS.

Read semantic tokens from `packages/ui/src/styles`. Preserve accessible contrast, visible focus, reduced-motion behavior and text labels for operational states. Keep feature compositions out of primitive components. Use Storybook for component states and the application for integrated journeys.

See [shared frontend components](docs/frontend-ui.md) and the [design workflow](docs/design-workflow.md).

## Local development and data

- Use the Node and pnpm versions pinned in `mise.toml`, `.nvmrc` and `package.json`. Prefix commands with `mise exec --` if mise is not activated in the shell.
- First checkout: `mise trust`, `mise install`, then `pnpm run setup`. Setup requires a Docker-compatible runtime with Compose and provisions dependencies, Chromium and demo data.
- `pnpm dev` starts the API and web app. `pnpm dev:workflows` also starts Temporal and the worker. Read actual URLs from command output; do not assume fixed ports.
- Each worktree owns its Compose project, ports, volumes, credentials and cookie prefix. Keep `.luma/` with its checkout; do not copy it between worktrees or delete its credentials while retaining the database volume.
- Use `pnpm dev:doctor` to diagnose the environment and `pnpm dev:down` to stop its infrastructure while retaining data. Stop only processes you started or have positively identified as belonging to the task; do not kill processes by broad name or path patterns.
- Use seeded synthetic data, the pilot and simulators for development. `pnpm db:reset` erases this checkout's database; it is not a routine troubleshooting step. Stop app and worker processes before an intended reset.
- Never point tests at development or production databases. `TEST_DATABASE_URL`, when supplied, must identify a disposable test cluster whose administrator can create databases and roles.
- Keep secrets in ignored local configuration. `VITE_*` values are public. Document new settings in the relevant `.env.example`, validate server settings, and add runtime variables to the appropriate Turbo task environment.

See [local development](docs/development.md) and the [pilot guide](docs/pilot-environment.md) for setup and recovery procedures.

## Verification

Start with the smallest meaningful proof. Test observable behavior and important failure cases, not implementation details or trivial callback wiring. Reuse existing identity, database and simulator fixtures. Wait for observable state with bounded assertions rather than adding arbitrary sleeps.

- Focused unit tests: `pnpm --filter @luma/resolution test inventory-monitor.test.ts`, substituting the owning package and file.
- Backend journey: `pnpm test:e2e <file.e2e.mjs>`. Browser journey: `pnpm test:browser <file.browser.mjs>`.
- Shared UI: `pnpm test:ui`; inspect relevant stories and test the integrated journey when routing, authentication or live data changes.
- Feature checks: `pnpm verify:feature <simulator|workflows|orders>`. Extend the explicit test selection when adding scenarios.
- Before review of code changes, run `pnpm check` and the relevant integration/browser suites. Documentation-only changes need `pnpm format:check` and `pnpm test:architecture`, which checks links and paths.
- `pnpm test:full` prepares the Code Step runtime and runs all CI gates, including simulator tooling and release evaluations, with a shared disposable PostgreSQL server. Its command coverage is checked against [CI](.github/workflows/ci.yml).
- `pnpm test:local` does not provision PostgreSQL and can skip database integration tests. Report that limitation when using it.

Backend E2E uses Vitest; browser E2E uses Playwright Test. Browser failures retain traces and screenshots under `.luma/playwright`; open the report with `pnpm test:browser:report`. See [feature validation](docs/development.md#feature-validation) and [performance measurement](docs/benchmarking.md).

Report what was checked, the result, and any unverified behavior. Do not describe a skipped suite as passing.

## Documentation and writing

- Write API descriptions and user-facing strings for the people using them: capabilities, expected behavior and necessary usage details. Use short sentences and concrete terms. Mention limitations when they affect correct use.
- Public product guides live in `apps/web/content/docs`. Explain how to accomplish a task; keep implementation choices, project history and contributor tooling out of them.
- Engineering guides in `docs` record only what the code does not show: rules and invariants, failure behavior, authority constraints, limits with their reasons, traps and supported procedures. Follow the [writing rules](docs/README.md#writing-guides).
- Do not add file, function, route or migration catalogs, test lists, dated measurements, ticket IDs or change history to guides. Search finds code; pull requests and Linear hold evidence and history.
- Extend the existing guide for a feature instead of adding a file per change. The codebase map lists owners and conventions only; update it when ownership changes, not for each feature.
- Architecture decisions with their alternatives live in `docs/architecture`. Keep local implementation explanations in code comments.
- Update or remove guidance made inaccurate by a change, in the same change.
- Comments explain purpose, behavior or non-obvious constraints for maintainers. Avoid narrating the code or describing hypothetical future work.

## Branches, pull requests and work artifacts

- Use `feat/<LINEAR-TICKET-ID>-<short-description>`, for example `feat/LUMA-123-add-project-search`. Keep the ticket ID uppercase and the description lowercase and hyphen-separated.
- Use Conventional Commits. PR titles include the Linear ticket, for example `LUMA-123: Add project search`.
- Keep one concern per PR. Link the issue, explain the behavior change and include relevant validation. Include before/after evidence when it helps review a visible change.
- Commit dependency lockfile and generated route-tree updates when affected. Regenerate `apps/web/src/routeTree.gen.ts`; do not edit it manually.
- Keep temporary plans, research notes and PR-only screenshots out of tracked source unless they are requested deliverables. Track active work in the owning Linear issue; retain durable decisions in repository documentation.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
