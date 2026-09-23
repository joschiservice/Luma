# @luma/inventory

Owns canonical SKU, location, and inventory-position identities and their projections.

## Responsibilities

Provider payload translation belongs to connections. Cross-domain ingestion belongs to commerce-ingestion. Preserve stable canonical identities when provider snapshots are replayed.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/inventory` — [source](./src/index.ts).
- `@luma/inventory/composition` — [source](./src/composition.ts).

## Workspace dependencies

[@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/inventory...
pnpm exec turbo run typecheck --filter=@luma/inventory
pnpm exec turbo run test --filter=@luma/inventory
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Engineering guide](../../docs/commerce-projections.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
