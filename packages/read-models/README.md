# @luma/read-models

Read-only workspace views: the record explorer, order and operational metrics, the operational summary and the Orders workspace.

## Responsibilities

Each read runs in one read-only, repeatable-read transaction under the tenant's row security. Business rules come from their owners as injected SQL building blocks: order state from `@luma/orders` and needs-you attention from `@luma/exceptions`. This package never writes. See [ADR-008](../../docs/architecture/008-workspace-read-models.md).

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/read-models` — [source](./src/index.ts).
- `@luma/read-models/composition` — [source](./src/composition.ts).
- `@luma/read-models/http` — [source](./src/http.ts).

## Workspace dependencies

[@luma/api-contract](../api-contract/README.md), [@luma/connections](../connections/README.md), [@luma/exceptions](../exceptions/README.md), [@luma/identity](../identity/README.md), [@luma/orders](../orders/README.md), [@luma/platform](../platform/README.md), [@luma/procurement](../procurement/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/read-models...
pnpm exec turbo run typecheck --filter=@luma/read-models
pnpm exec turbo run test --filter=@luma/read-models
TEST_DATABASE_URL=… pnpm --filter @luma/application-runtime exec vitest run src/orders.integration.test.ts src/commerce.integration.test.ts
```
