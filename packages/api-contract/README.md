# @luma/api-contract

Shared HTTP contracts, request and response schemas, typed client helpers, and OpenAPI generation for Luma.

## Responsibilities

Keep transport schemas here. Domain rules and database access belong to their owning backend packages. Update contracts and their consumers together when changing API behavior.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/api-contract` — [source](./src/index.ts).
- `@luma/api-contract/client` — [source](./src/client.ts).
- `@luma/api-contract/openapi` — [source](./src/openapi.ts).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/api-contract...
pnpm exec turbo run typecheck --filter=@luma/api-contract
pnpm exec turbo run test --filter=@luma/api-contract
```

Run `pnpm --filter @luma/api-contract generate:openapi` after changing contracts to regenerate the OpenAPI document.

## Further reading

- [Engineering guide](../../docs/api.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
