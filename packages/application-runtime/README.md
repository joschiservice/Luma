# @luma/application-runtime

Assembles Luma services and their HTTP, workflow-worker and sync-worker runtimes from explicit dependencies, and owns the ordered database migrations.

The shared service factory wires domains once for development, pilot and simulator. Provider adapters, execution effects and scenario inputs are injected; fixture setup stays in tooling. Runtime constructors own startup and resource cleanup. Keep domain decisions in their owning packages.

Migrations live in [migrations](migrations) and run with `pnpm --filter @luma/application-runtime db:migrate` using `MIGRATION_DATABASE_URL`. Add new files; never rename or edit applied ones, because the ledger checks filenames and checksums. Cross-package integration tests in this package need `TEST_DATABASE_URL`; `pnpm test` provides a disposable server.

## Public entry points

- `@luma/application-runtime` — HTTP application.
- `@luma/application-runtime/worker` — Temporal workflow worker.
- `@luma/application-runtime/sync` — commerce sync worker and operator sync service.

## Further reading

- [Local development](../../docs/development.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
