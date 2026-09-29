# @luma/orders

Owns canonical orders, order lines, fulfillment identities, and their projections, including maintained order list rows and search links.

## Responsibilities

Provider payload translation belongs to connections. Inventory reference validation is injected, and commerce-ingestion coordinates updates across owners. Preserve stable canonical identities during replay.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/orders` — [source](./src/index.ts).
- `@luma/orders/composition` — [source](./src/composition.ts).

## Workspace dependencies

[@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/orders...
pnpm exec turbo run typecheck --filter=@luma/orders
pnpm exec turbo run test --filter=@luma/orders
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Orders workspace and list backfill](../../docs/orders-workspace.md)
- [Engineering guide](../../docs/commerce-projections.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
