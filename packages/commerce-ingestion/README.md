# @luma/commerce-ingestion

Coordinates provider source records and canonical order and inventory projections.

## Responsibilities

Ingestion crosses domain boundaries through public contracts. Preserve replay and idempotency when a projection fails partway through processing; provider transport and canonical entity ownership remain in their respective packages.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/commerce-ingestion` — [source](./src/index.ts).

## Workspace dependencies

[@luma/connections](../connections/README.md), [@luma/identity](../identity/README.md), [@luma/inventory](../inventory/README.md), [@luma/orders](../orders/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/commerce-ingestion...
pnpm exec turbo run typecheck --filter=@luma/commerce-ingestion
pnpm exec turbo run test --filter=@luma/commerce-ingestion
```

## Further reading

- [Engineering guide](../../docs/architecture/002-canonical-commerce-model.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
