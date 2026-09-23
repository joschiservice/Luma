# @luma/application-runtime

Assembles Luma services and their HTTP and worker runtimes from explicit dependencies.

## Responsibilities

The shared service factory wires domains once for normal development, pilot, and simulator. Provider adapters, execution effects, and scenario inputs are injected; fixture setup stays in tooling. Runtime constructors own startup and resource cleanup. Keep domain decisions in their owning packages.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/application-runtime` — [source](./src/app.ts).
- `@luma/application-runtime/worker` — [source](./src/composition/workflow-runtime.ts).

## Workspace dependencies

[@luma/api-contract](../api-contract/README.md), [@luma/audit](../audit/README.md), [@luma/commerce-ingestion](../commerce-ingestion/README.md), [@luma/config](../config/README.md), [@luma/connections](../connections/README.md), [@luma/exceptions](../exceptions/README.md), [@luma/execution](../execution/README.md), [@luma/identity](../identity/README.md), [@luma/inventory](../inventory/README.md), [@luma/orders](../orders/README.md), [@luma/platform](../platform/README.md), [@luma/policies](../policies/README.md), [@luma/resolution](../resolution/README.md), [@luma/workflow-temporal](../workflow-temporal/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/application-runtime...
pnpm exec turbo run typecheck --filter=@luma/application-runtime
pnpm exec turbo run test --filter=@luma/application-runtime
```

Database migrations live in [migrations](migrations) and run with `pnpm --filter @luma/application-runtime db:migrate` using `MIGRATION_DATABASE_URL`. Preserve migration ordering and the existing ledger. Use `pnpm test` for the complete suite with a disposable PostgreSQL database; direct package tests need `TEST_DATABASE_URL` for database coverage.

## Further reading

- [Local development](../../docs/development.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
