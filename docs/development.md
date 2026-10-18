# Local development

Each checkout runs its own PostgreSQL, Valkey, Temporal, ports, credentials and cookie prefix, so
worktrees never share state. Tests always use disposable databases.

Install mise and a Docker-compatible runtime with Compose v2, then:

```sh
mise trust
mise install
mise run setup
mise run dev
```

With mise activated in the shell, use `pnpm` directly; otherwise prefix commands with
`mise exec --`. Node and pnpm are
pinned in `mise.toml`; keep `.nvmrc` and `packageManager` in `package.json` in sync when
updating them.

## Commands

| Command                   | Behavior                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run setup`          | Install dependencies, Chromium and the Code Step runtime, start PostgreSQL and Valkey, migrate, provision roles and seed demo data. Safe to repeat. |
| `pnpm dev`                | Start PostgreSQL and Valkey if needed, apply migrations, and watch the API, web app, commerce sync process, config and contracts.                   |
| `pnpm dev:workflows`      | Also start Temporal and its UI, and watch the workflow worker.                                                                                      |
| `pnpm dev:observe`        | Also start the local Grafana stack; see [observability](observability.md).                                                                          |
| `pnpm dev:doctor`         | Check tool versions, containers, database logins and API readiness. Run while the app is running.                                                   |
| `pnpm dev:down`           | Stop this checkout's containers; keep volumes and credentials.                                                                                      |
| `pnpm dev:manual`         | Watch app processes using your own `.env` files and services.                                                                                       |
| `pnpm db:seed`            | Create or reuse the demo user, workspace and synthetic exceptions.                                                                                  |
| `pnpm db:reset`           | Erase this checkout's database, migrate, provision roles and reseed. Stop app and worker processes first.                                           |
| `pnpm db:studio`          | Open Drizzle Studio on this checkout's database as the administrator, across all workspaces. Edits are written directly.                            |
| `pnpm pilot`, `simulator` | Synthetic provider environments; see the [pilot](pilot-environment.md) and [simulator](simulator.md) guides.                                        |
| `pnpm storybook`          | Component workshop; needs no API.                                                                                                                   |

Setup creates `demo@example.test` with a generated password in `.luma/demo.json`, one AU
workspace and two synthetic exceptions taken from the golden corpus. Seeding uses the real
services and is idempotent, and marks its accounts' email addresses confirmed. Local
development has no mail provider, so an account created through the sign-up page can't be
confirmed or signed in to; use the seeded accounts. For the other exception classes and safe
execution, use the pilot.

`pnpm db:reset` also drops the simulator database and archives pilot and simulator
manifests under `.luma/backups/`; the next launch seeds fresh state. Temporal history is
kept. It is not a troubleshooting step.

Safari and Brave need HTTPS for Drizzle Studio: `brew install mkcert && mkcert -install`
once, then restart `pnpm db:studio`.

## Worktrees and configuration

- Ports are chosen once per checkout and stored in `.luma/state.json`; commands print the
  URLs. API origins, trusted browser origins and the Vite proxy are derived together.
- `.luma/` is ignored and holds this checkout's secrets. Keep it with its checkout. Do not
  copy it to another worktree or delete it while keeping the database volume: its passwords
  are needed to reconnect.
- Generated settings in `.luma/env` take precedence over `apps/api/.env` and
  `apps/web/.env` for database, ports and auth. Other settings, such as model and telemetry
  configuration, come from those files; copy the `.env.example` first.
- Document every new setting in the relevant `.env.example` and validate server settings
  in `@luma/config`. `VITE_*` values are public; never put credentials in them or import
  server configuration into the web client.
- Turborepo runs in strict environment mode. Add new runtime variables to the task `env` in
  `turbo.json`, especially variables read during builds, so they affect cache keys.
- The API listens on `127.0.0.1` by default; containers must set `HOST=0.0.0.0`.

### Database roles

The migration administrator is used only during initialization. Runtime logins never have
superuser, database creation, role creation or RLS bypass privileges.

The local logins `luma_api`, `luma_worker` and `luma_staff` inherit domain group roles such as
`luma_identity`, `luma_desk` and `luma_connectors`; `tooling/dev/database.mjs` defines which.
A migration that adds a table grants it to the owning role and, where needed, to reader
roles; follow the [add-migration](../.agents/skills/add-migration/SKILL.md) skill. See
[ADR-003](architecture/003-tenant-isolation-and-data-residency.md).

### API source imports

The API's development scripts and Vitest load TypeScript source through the `luma-source`
export condition. To run API source directly, pass `--conditions=luma-source`, for example
`pnpm --filter @luma/api exec tsx --conditions=luma-source src/index.ts`. Production uses
the compiled `dist` output.

## Feature validation

Start with the smallest check that proves the change, then widen:

| Scope               | Command                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| One rule or service | `pnpm --filter @luma/resolution test inventory-monitor.test.ts`                           |
| One backend journey | `pnpm test:e2e returns.e2e.mjs`                                                           |
| One browser journey | `pnpm test:browser returns.browser.mjs`                                                   |
| Your branch         | `pnpm test:affected`                                                                      |
| Shared components   | `pnpm test:ui`                                                                            |
| A feature area      | `pnpm verify:feature <simulator\|workflows\|orders\|inbox\|purchasing\|stock-protection>` |
| Before review       | `pnpm check`                                                                              |
| Every CI gate       | `pnpm test:full`                                                                          |

`pnpm verify:feature` builds once, then runs formatting, lint, focused package checks with
a disposable database and the related journeys. It stops at the first failure and keeps a
numbered log per step in the printed directory. It does not replace `pnpm check` and does
not touch your local simulator workspace. Extend its selection in
`tooling/dev/verify-feature.mjs` and `tooling/dev/test-plan.mjs` when adding a scenario.

## Tests

`pnpm test`, `pnpm test:e2e` and `pnpm test:browser` start PostgreSQL through
Testcontainers and remove it afterwards. Each suite creates its own database and restricted
runtime logins. To use a separate cluster, set `TEST_DATABASE_URL` to an administrator
connection that can create databases and roles. Never point it at a development or
production database.

The test runner provisions a disposable Valkey instance alongside PostgreSQL and overrides
`SHOPIFY_ADMISSION_URL` for the run. Tests never use the checkout's admission service.
Local Compose starts an authenticated Valkey instance with persistence and `noeviction`;
its URL is generated in the checkout's ignored environment for API and worker processes.

`pnpm test:local` runs without containers; database and Valkey integration suites skip and E2E
suites cannot run. Report that limitation when relying on it.

- The test container disables `fsync`, `full_page_writes` and `synchronous_commit`.
  Every `DROP DATABASE` waits for a checkpoint, so durable writes make parallel teardown
  exceed hook timeouts. Apply the same settings to a supplied cluster.
- Migration helpers hold a cluster-wide advisory lock, so database setup does not scale
  with more workers.
- E2E suites run on half the available CPUs, capped at four backend and six browser
  workers. Backend files run in parallel with their tests in sequence; browser tests run in
  parallel even within a file, so each test sets up its own state. Browser workers reuse
  Chromium with a fresh context and database per test. A supplied cluster needs enough
  connections for the worker count.
- Browser journeys serve the web and staff apps from their production builds, which
  `pnpm test:browser` prepares. A dev server compiled each page on first request, which cost
  every test seconds. React's development-only checks therefore don't run in journeys.
- Retries are disabled so flaky failures stay visible. Reproduce with
  `pnpm test:browser --workers=1`, `pnpm test:e2e --maxWorkers=1`, `--grep "<name>"`,
  `--headed` or `--shard=1/4`.
- Browser failures keep traces and screenshots in `.luma/playwright`; open the report with
  `pnpm test:browser:report`.
- The pilot recovery test kills a worker after a provider write and waits out the
  20-second activity heartbeat timeout. Keep that real crash coverage; do not shorten the
  production timeout to speed up tests.
- Use `pnpm run test --filter=<package>` (with `run`) so pnpm forwards the filter to the
  database runner.

The shared validation runner queues commands per checkout so overlapping runs do not compete for database,
Chromium and build resources. Nested commands in `check` and `test:full` share the active
run; independent worktrees keep separate queues. Backend and browser journeys also take a
journey slot shared by every checkout of the same user, because each run already uses half the
CPUs and parallel runs from several worktrees time each other out. A run holds its slot from
its first journey until it ends, and waiting runs print the checkout that holds it.
`LUMA_JOURNEY_SLOTS` allows more concurrent runs on a larger machine. Interrupted runs
release the lease or slot, or their heartbeat expires automatically. Direct package tests and
Turbo commands bypass this coordination.

### Cached and affected tests

Turbo caches each package's `test` result. The hash covers the package's files, the builds
of its workspace dependencies, extra inputs declared in the package's `turbo.json`, and
`LUMA_TEST_CAPABILITIES`. The test runner sets that variable to the optional dependencies
present: PostgreSQL, Valkey and the Code Step runtime. A run that skipped database suites is
therefore never reused for a run that can execute them. The database URL is not hashed,
because each run gets new disposable containers. Run tests through the `pnpm test*` scripts.
Running `turbo run test` directly with `TEST_DATABASE_URL` set bypasses the marker. Add
`--force` to rerun cached results.

The root `package.json` must not depend on workspace packages. Turbo adds the sources of
root dependencies to every task hash, so a change to any of them would miss every cache
and select every task. Scripts under `tooling/` declare the packages they import in
`tooling/package.json`; `pnpm test:architecture` checks this.

A test that reads a file outside its package and that package's dependencies must list
the file in the package's `turbo.json` test `inputs`. Otherwise a change to that file
replays a stale result. `pnpm test:architecture` finds such relative paths and fails until
they are declared.

`pnpm test:affected` compares the working tree, including uncommitted and untracked files,
with the merge base of `main` (override with `TURBO_SCM_BASE`). It runs:

- unit tests whose task inputs changed;
- the backend and browser journeys that exercise the changes.

`TURBO_SCM_BASE=HEAD pnpm test:affected` selects only for uncommitted changes, which keeps
iterations small on a branch that already touches shared code. `pnpm test:e2e --affected`
and `pnpm test:browser --affected` apply the same selection to one suite. Journeys are selected from [journey-areas.mjs](../apps/api/e2e/journey-areas.mjs):

- A changed journey, or a module it imports by relative path, selects that journey.
- Ignored paths select nothing.
- A shared path selects every journey.
- A path a journey declares selects that journey.
- Any other path selects every journey, and the runner prints it.

When a full run names an unmapped path, map it to the journeys that exercise it rather than
marking it shared. Every journey file must be mapped; `pnpm test:tooling` checks this and
that every pattern still matches a file.

Pull requests in CI use affected selection for unit tests and journeys. Pushes to `main`
run every journey, so a missing mapping still fails there. Selection trades coverage for
speed: run the full journey suites when a change alters behavior shared across features.

CI runs the same gates as `pnpm test:full` in parallel jobs. A regression test compares
the two; update both when adding a gate. The required `Quality gates` check passes only
when every job succeeds.

## Repository checks

- `pnpm lint` enforces package and layer boundaries, import order, spacing and doc
  comments on exported functions; `pnpm test:architecture` checks the boundary policy and
  documentation links; `pnpm test:style` checks the lint configuration.
- Run `pnpm lint:fix`, then `pnpm format`. Both interfaces and type aliases are allowed:
  database row types rely on the implicit index signature of type aliases. An
  intentionally empty production callback needs a comment.
- `pnpm knip:check` finds unused files, dependencies and exports in every workspace,
  including entry-point exports and exported types, so packages export only what other code
  uses, and imports of packages a workspace does not declare. Name re-exported types
  explicitly instead of `export type *`. Knip does not see types that declaration emit names
  in inferred signatures; when `pnpm build` fails because such a type is not exported, export
  it with a `@public` tag that names the inferred export. Runtime-loaded entry points and
  deliberate exceptions belong in `knip.jsonc`. A package's `tsconfig.json` needs `rootDir`
  and `outDir` so knip maps imports of its compiled `dist` exports back to source.
  `pnpm test:architecture` also checks that each workspace declares the workspace packages
  it imports; pnpm would otherwise resolve them only by accident.
- `pnpm typecheck:tooling` type-checks tooling modules with JSDoc. Add a module to
  `tooling/tsconfig.json` when bringing it under checks.
- Shared dependency versions live in `pnpm-workspace.yaml` catalogs. Upgrade a catalog
  version as its own change.

## Troubleshooting

- **No container runtime:** start Docker and check `docker info` and
  `docker compose version`.
- **Wrong Node version:** activate mise or use `mise exec -- pnpm dev`.
- **Port in use:** stop the other process, or edit `apiPort`/`webPort` in
  `.luma/state.json` while this checkout is stopped.
- **API not ready:** run `pnpm dev` to apply migrations, then `pnpm dev:doctor`.
- **Missing browser:** rerun `pnpm run setup`. On Linux, add Playwright's `--with-deps`.
- **Database password mismatch:** restore this checkout's original `.luma/state.json`;
  bootstrap deliberately keeps existing data.

## Cell region

New checkouts, seed data and disposable test databases use `AU`. Every process compares
`LUMA_REGION` with the immutable cell record before serving requests or loading work.
An existing local database containing EU workspaces must use `LUMA_REGION=EU` and
`LUMA_ENABLED_REGIONS=EU` in its API environment, or be intentionally reset. Setup never
converts workspace data between regions.

For a new deployment, run the shared migrations, then
`pnpm --filter @luma/application-runtime db:provision-region` with migration credentials
in `MIGRATION_DATABASE_URL`. Runtime roles cannot initialize or alter the cell record.
The provisioning command rejects a different region once the record exists and rejects
existing workspaces in another region. Database restore procedures must preserve this record.

## Dependency advisories

`pnpm audit:dependencies` checks production and development dependencies against current
registry advisories. CI runs it on changes and weekly. Review reachability before accepting
an exception in `tooling/dev/dependency-exceptions.json`: bind it to one advisory, module, dependency path and
installed version, explain the affected feature and why it cannot be reached, name a reviewer
and set an expiry. Expired reviews and newly affected versions fail the gate. Registry errors
also fail rather than reporting a clean scan. Prefer compatible dependency updates; do not
replace an old transport or compiler API with an incompatible override to silence a scanner.
