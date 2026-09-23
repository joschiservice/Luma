# @luma/audit

Defines audit entries and the append-only audit log, with tenant-scoped persistence.

## Responsibilities

Callers supply the tenant transaction and audit event. Keep the business decision that produces an event in its owning domain; this package records the evidence.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/audit` — [source](./src/index.ts).
- `@luma/audit/composition` — [source](./src/composition.ts).

## Workspace dependencies

[@luma/platform](../platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/audit...
pnpm exec turbo run typecheck --filter=@luma/audit
pnpm exec turbo run test --filter=@luma/audit
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Engineering guide](../../docs/execution.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
