# @luma/platform

Provides tenant database contracts, canonical JSON, observability, performance instrumentation, and model gateway infrastructure.

## Responsibilities

Keep this package focused on technical capabilities shared across domains. Business rules belong in domain packages. Tenant transactions and model routing must preserve tenant isolation and data-region constraints.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/platform` — [source](./src/index.ts).
- `@luma/platform/composition` — [source](./src/composition.ts).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/platform...
pnpm exec turbo run typecheck --filter=@luma/platform
pnpm exec turbo run test --filter=@luma/platform
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Engineering guide](../../docs/architecture/003-tenant-isolation-and-data-residency.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
