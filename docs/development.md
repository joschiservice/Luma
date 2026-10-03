# Local development

Install mise and a Docker-compatible runtime with Compose v2. Docker Desktop and
OrbStack are examples; the repository uses the Docker CLI and Testcontainers.

```sh
mise trust
mise install
mise run setup
mise run dev
```

Activate mise in your shell to use `pnpm` directly, or prefix commands with
`mise exec --`. Mise pins Node 24.21.0 and pnpm 12.4.2. When updating these tools,
keep `.nvmrc`, `mise.toml`, and `package.json` in sync.

## Commands

| Command              | Behavior                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm run setup`     | Install dependencies and Chromium, start PostgreSQL, migrate, provision roles, and seed demo data. Safe to repeat. |
| `pnpm dev`           | Start PostgreSQL if needed, apply migrations, and watch the API, web app, config and contracts.                    |
| `pnpm dev:workflows` | Also start Temporal and its UI, and watch the workflow worker.                                                     |
| `pnpm db:seed`       | Create or reuse the demo user/workspace and synthetic exception evidence.                                          |
| `pnpm db:reset`      | Erase this worktree's local database, apply all migrations, provision roles, and seed demo data.                   |
| `pnpm dev:doctor`    | Check tool versions, containers, database logins, and API readiness. Run while the app is running.                 |
| `pnpm dev:down`      | Stop this checkout's containers and remove their network; retain volumes.                                          |
| `pnpm dev:manual`    | Watch app processes using your app `.env` files and existing services.                                             |
| `pnpm test:full`     | Run every CI gate against a disposable Testcontainers database.                                                    |

## Feature validation

Use the [codebase map](codebase-map.md) to select the relevant tests. For simulator work:

```sh
mise exec -- pnpm verify:feature simulator
```

This runs repository formatting and lint, one build of the API and simulator dependency graphs, focused type and unit checks for simulator packages, resolution and exceptions, the database-backed simulator host and adapter contract tests, and the inventory platform E2E and browser suites. Steps run sequentially and stop on the first failure. Each step prints its status and writes full output to a numbered log under the printed temporary directory; failures also show the last 30 lines. Logs remain available after the command exits.

Docker and Playwright Chromium are required. Install Chromium with `pnpm --filter @luma/api exec playwright install chromium`. The platform suites share one disposable PostgreSQL server, with isolated databases per test. If `TEST_DATABASE_URL` is set, the existing test runner uses that server instead; use a test administrator connection that can create databases and roles. The command does not start or reset your local simulator workspace.

| Tier              | When to use it                                           | Command                                                         |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Focused unit test | While changing a rule or service                         | `pnpm --filter @luma/resolution test inventory-monitor.test.ts` |
| Simulator feature | Before handing off a simulator change                    | `pnpm verify:feature simulator`                                 |
| Repository gate   | Final validation across packages                         | `pnpm check`                                                    |
| All CI gates      | Changes spanning platform workflows and browser surfaces | `pnpm test:full`                                                |

The feature command accepts `simulator`, `workflows` and `orders`. Each prepares the Code Step runtime, builds dependencies, checks selected packages with a disposable database, and runs related journeys. Workflows covers authoring, triggers, playbooks, Code Steps and replenishment; Orders covers order/read-model/ingestion packages and order/record browser journeys. It does not replace `pnpm check` or run unrelated platform E2E suites. Individual `test:e2e` and `test:browser` commands still build their prerequisites for standalone use.

## API imports

Use native package imports such as `#modules/identity/index` and
`#modules/workflows/composition` without file extensions. The module boundary
rules still apply; cross-module imports must use the provider's `index` entry.

The API development scripts and Vitest select the `luma-source` condition to load
TypeScript source. When running API source directly, include
`--conditions=luma-source`, for example
`pnpm --filter @luma/api exec tsx --conditions=luma-source src/index.ts`.
Production commands use the default mapping to compiled files in `dist`.

## Configuration and worktrees

Each checkout has a Compose project derived from its absolute path. Compose
assigns PostgreSQL and Temporal host ports. App ports are selected once and stored
in `.luma/state.json`; the commands print their URLs. API origins, browser trusted
origins and Vite's proxy are configured together. Each worktree uses a distinct
`BETTER_AUTH_COOKIE_PREFIX` so browser sessions do not collide across ports. Services bind to loopback.

`.luma/` is ignored by Git and contains local secrets and configuration. Keep it
with its checkout. `pnpm dev:down` preserves the volumes and secrets, so restarting
retains users and sessions. Do not copy `.luma/` to a different worktree or delete
it while retaining the associated database volume: its passwords are needed to
reconnect. A new worktree starts with independent storage.

Generated runtime settings are available in `.luma/env`. Managed commands pass
these settings to child processes; they never rewrite `apps/api/.env` or
`apps/web/.env`. Generated database connections, ports and authentication settings
take precedence over those files. Other app settings, including optional model
and telemetry configuration, still use the existing app environment mechanism.
Use `pnpm dev:manual` when you want to control the database and auth settings.

The migration administrator connection is used only during initialization.
`luma_api` inherits `luma_identity`, `luma_connectors`, `luma_case_reader`,
`luma_desk` and `luma_commerce_sync`. The desk role includes policy and audit permissions for decisions.
`luma_worker` inherits `luma_exceptions`, `luma_policies`, `luma_execution`,
`luma_audit`, `luma_connectors`, `luma_orders`, `luma_inventory`, `luma_desk`,
`luma_commerce_sync` and `luma_customers`. Neither runtime login has
superuser, database creation, role creation or RLS bypass privileges.

`pnpm dev` also starts the commerce sync process (`apps/worker`), which imports
history for active connections and keeps it current. It uses the worker login and
reads Shopify approval flags from `apps/api/.env`. See [Commerce sync](commerce-sync.md).

Temporal runs only when requested. Its development server persists workflow
history in this checkout's Temporal volume. The command prints its Web UI URL.
Ctrl+C stops watched processes; infrastructure remains
available until `pnpm dev:down`.

## Demo data

Stop app and worker processes before running `pnpm db:reset`. The command deletes
all data in this checkout's managed PostgreSQL database and recreates the demo
workspace. It requires an existing local setup and preserves local credentials
and configuration. It also drops the simulator's `luma_simulator` database. Pilot
and simulator manifests are archived under `.luma/backups/database-reset-*`; the
next pilot or simulator launch seeds fresh state. Temporal workflow history is retained. Use the
[pilot reset](pilot-environment.md) to reset a pilot scenario without resetting
the database.

Setup creates `demo@example.test` with a generated password recorded in
`.luma/demo.json`, one EU workspace, and two synthetic exceptions: a connector
authentication failure and an exhausted workflow failure. Seeding uses the real
authentication, organization and exception services. Repeating it preserves the
same user, workspace and evidence. The exception timestamps match the versioned
golden corpus; no external connector calls occur. The case inbox displays those
persisted exceptions. For all four exception classes, operator states and
fixture-backed safe execution, use the [synthetic pilot](pilot-environment.md).

## Tests

`pnpm test`, `pnpm test:e2e`, and `pnpm test:browser` start PostgreSQL 17 through
Testcontainers unless `TEST_DATABASE_URL` is supplied. `pnpm test:full` shares one
container across all checks. Each database suite continues to create its own
isolated database and restricted runtime login. Containers are removed on normal
completion or failure. Testcontainers' resource reaper handles abandoned resources.

The test container runs with `fsync`, `full_page_writes`, and `synchronous_commit`
off. Suites drop their databases during teardown, and each `DROP DATABASE` waits for
a checkpoint; with durable writes, parallel suites can exceed hook timeouts.

To use a separately managed disposable cluster, set `TEST_DATABASE_URL` to an
administrator connection with database and role creation permissions. Do not use
a development or production database. Apply the same settings to that cluster for
comparable teardown times. CI uses the same Testcontainers path as
local full checks. No fixed database or browser test ports are required.

CI runs static checks and builds, main tests, UI component tests, two backend E2E
shards, four browser shards, simulator tests, and release evaluations in parallel.
Database suites provision their own PostgreSQL container. Turbo build results are
cached between runs; tests always execute. CI limits simultaneous Turbo tasks to
the available CPU count and runs Storybook separately from the main tests.

E2E suites use half the available CPUs, capped at four backend files or six browser
files at once. Tests within a file remain sequential. On a two-CPU CI runner, each
shard runs one file at a time.
Browser E2E uses Playwright Test; backend E2E uses Vitest. Use
`pnpm test:browser --shard=1/4` to reproduce a browser shard,
`pnpm test:browser --workers=1` for sequential browser tests, or
`pnpm test:e2e --maxWorkers=1` for sequential backend tests.
Browser workers reuse Chromium with fresh contexts and databases for each test.
Failures retain traces and screenshots in `.luma/playwright/results`; HTML and
JSON reports are written to `.luma/playwright/`. Open the report with
`pnpm test:browser:report`. CI uploads a separate report artifact for each shard.
Retries remain disabled so failures are visible.

To select a browser journey, use `pnpm test:browser identity.browser.mjs`, or
`pnpm test:browser --grep "journey name"`. Add `--headed` to watch Chromium.
See [benchmarking](benchmarking.md) for repeated measurements with Hyperfine.
`pnpm run test` accepts Turbo arguments; CI uses `pnpm run test '--filter=!@luma/ui'`
because the UI has its own job. Use the explicit `run` form with `--filter` so pnpm
forwards the filter to the test runner. Plain `pnpm test` still includes UI tests.

See [test performance](test-performance.md) for measurements and further options.

For a fast check without containers, use `pnpm test:local`. Database integration
suites skip if no test connection is supplied; backend and browser E2E require a
database. `pnpm test:ui` and Storybook do not need PostgreSQL.

## Troubleshooting

- A missing container runtime: start Docker and verify `docker info` and `docker compose version`.
- Wrong Node version: use `mise exec -- pnpm dev` or activate mise in your shell.
- An occupied app port: stop the other process or edit `apiPort`/`webPort` in `.luma/state.json` while this checkout is stopped. Restart to regenerate matching origins and proxy settings.
- API readiness failure: run `pnpm dev` to apply pending migrations, then `pnpm dev:doctor` to check the restricted connections.
- Missing browser executable: rerun `pnpm run setup`. On Linux, install Playwright system dependencies with `pnpm --filter @luma/api exec playwright install --with-deps chromium` and the corresponding `@luma/ui` command.
- Database password mismatch: restore this checkout's original `.luma/state.json`; bootstrap deliberately does not discard existing data.

References: [mise](https://mise.jdx.dev/walkthrough.html),
[Compose services](https://docs.docker.com/reference/compose-file/services/),
[Testcontainers PostgreSQL](https://node.testcontainers.org/modules/postgresql/),
[Temporal CLI](https://github.com/temporalio/cli/blob/main/README.md).

## Repository quality checks

Shared dependency versions live in `pnpm-workspace.yaml` catalogs. Keep named catalogs
when consumers deliberately require different versions, such as Zod 3 and 4.
Change a catalog version as a separate dependency upgrade with relevant validation.

`pnpm knip:check` checks unused files and dependencies across all workspaces and
runtime exports in the connector-core package. `pnpm knip --workspace <path>` runs
a broader audit for a workspace. Extend the export gate as packages become clean.
Runtime-loaded entry points and documented exceptions belong in `knip.jsonc`;
review consumers before removing a reported dependency or export.

`pnpm typecheck:tooling` checks the shared process, environment and test-plan helpers
with strict TypeScript `checkJs`. Add JSDoc contracts and expand `tooling/tsconfig.json`
when bringing another tooling module under type checking. The root typecheck includes it.

`pnpm test:full` includes Code Step setup, repository checks, backend and browser
E2E, simulator tooling, evaluation tests, playbook evaluation and code evaluation.
A regression test compares its command coverage with the CI matrix. Keep both in
sync when adding a gate. Optional model-backed authoring evaluation is not a CI gate.

Performance scenarios write measurements, budgets and violations to `.luma/performance`.
CI uploads reports separately for each backend/browser shard and summarizes budgets
in the job summary. Reports are written before budget failures are raised. Order-page
payloads are capped at 128 KiB for 50 items, metric SSE frames at 4 KiB, the five measured SSE subscribers at 128 KiB total
for the live-metric scenario, and the
cross-domain summary at 12 SELECT/WITH statements for its six readers. These are
regression ceilings, not production latency guarantees. The live-metric scenario
retains its existing one-second commit-to-visible p95 assertion. Review the scenario
and report before changing a budget; do not increase it just to silence a failure.
