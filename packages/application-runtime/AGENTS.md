# @luma/application-runtime

Composition: wires domain services into the HTTP app, the Temporal worker and the commerce
sync worker, owns resource lifecycle and the ordered core migrations, and hosts the
cross-package database integration tests. See the [README](README.md) and
[ADR-005](../../docs/architecture/005-domain-packages-and-runtimes.md).

## Composition

- `createApplicationServices` in `src/composition/application.ts` is the one service graph
  for the API, worker, pilot (`tooling/pilot`) and simulator. Change wiring there instead
  of patching one process; a fix wired into one runtime path may be missing in another.
- Composition wires; it never decides. Business rules stay in the owning package.
  Provider adapters, execution effects and scenario inputs are injected; fixture setup
  stays in tooling.
- Execution defaults fail closed: `execution.kind = 'disabled'` resolves no actions, and
  eligibility readers and verifiers deny when none is installed. Don't add permissive
  defaults.
- Runtime constructors own their resources. `buildRuntimeApp` must clean up everything it
  opened when initialization fails, and each process closes its pools on shutdown.
- `src/composition/features/<package>.ts` implements each API contract route area once;
  `features.test.ts` checks that every contract area has exactly one slice. Keep registry
  keys sorted.

## Migrations

- Core migrations are numbered SQL files in `packages/application-runtime/migrations`,
  applied in filename order and recorded with checksums. Add a new file; never rename or
  edit an applied one. App migrations live in their app package and run after these.
- A new table needs forced tenant RLS and grants to its owning runtime role only, plus
  readers where needed. Runtime roles never get migration, `BYPASSRLS` or owner
  privileges. See [database roles](../../docs/development.md#database-roles) and
  [ADR-003](../../docs/architecture/003-tenant-isolation-and-data-residency.md).

## Tests

- `*.integration.test.ts` files skip without `TEST_DATABASE_URL`. Run them through the
  database runner:
  `pnpm run test --filter=@luma/application-runtime -- <file>`.
- Use `createMigratedDatabase` from `src/test-support/database.ts` and the safety and
  detection fixtures beside it; don't provision databases or roles by hand. Migration setup
  holds a cluster-wide lock, so database setup does not get faster with more workers.
- Tests that read files outside this package must list them in `turbo.json` test
  `inputs`, as the API sources and app manifests already are.
