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

This runs repository formatting and lint, one build of the API and simulator dependency graphs, focused type and unit checks for simulator packages, resolution and exceptions, simulator integration/panel tests, and the inventory platform E2E and browser suites. Steps run sequentially and stop on the first failure. Each step prints its status and writes full output to a numbered log under the printed temporary directory; failures also show the last 30 lines. Logs remain available after the command exits.

Docker and Playwright Chromium are required. Install Chromium with `pnpm --filter @luma/api exec playwright install chromium`. The platform suites share one disposable PostgreSQL server, with isolated databases per test. If `TEST_DATABASE_URL` is set, the existing test runner uses that server instead; use a test administrator connection that can create databases and roles. The command does not start or reset your local simulator workspace.

| Tier              | When to use it                                           | Command                                                         |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Focused unit test | While changing a rule or service                         | `pnpm --filter @luma/resolution test inventory-monitor.test.ts` |
| Simulator feature | Before handing off a simulator change                    | `pnpm verify:feature simulator`                                 |
| Repository gate   | Final validation across packages                         | `pnpm check`                                                    |
| All CI gates      | Changes spanning platform workflows and browser surfaces | `pnpm test:full`                                                |

The feature command currently accepts only `simulator`. It does not replace `pnpm check` or run unrelated platform E2E suites. Individual `test:e2e` and `test:browser` commands still build their prerequisites for standalone use.

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
`luma_api` inherits `luma_identity`, `luma_connectors`, `luma_case_reader` and
`luma_desk`. The desk role includes policy and audit permissions for decisions.
`luma_worker` inherits `luma_exceptions`, `luma_policies`, `luma_execution`,
`luma_audit`, `luma_connectors`, `luma_orders`, `luma_inventory` and `luma_desk`. Neither runtime login has
superuser, database creation, role creation or RLS bypass privileges.

Temporal runs only when requested. Its development server persists workflow
history in this checkout's Temporal volume. The command prints its Web UI URL.
Ctrl+C stops watched processes; infrastructure remains
available until `pnpm dev:down`.

## Demo data

Stop app and worker processes before running `pnpm db:reset`. The command deletes
all data in this checkout's managed PostgreSQL database and recreates the demo
workspace. It requires an existing local setup and preserves local credentials
and configuration. Pilot manifests and simulator state are archived under
`.luma/backups/database-reset-*`; the next pilot or simulator launch seeds fresh
state. Temporal workflow history is retained. Use the
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
Both E2E commands accept Vitest arguments: use `pnpm test:browser --shard=1/4` to
reproduce a browser shard, or `pnpm test:e2e --maxWorkers=1` for a sequential run.
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
