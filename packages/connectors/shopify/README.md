# @luma/connector-shopify

Provides Shopify Admin GraphQL transport, OAuth token exchange and refresh, and callback and webhook signature verification.

## Responsibilities

Supply credentials and transport explicitly. The client resolves the access token for requests; connection lifecycle, tenant permissions, and encrypted storage belong to connections.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/connector-shopify` — [source](./src/index.ts).
- `@luma/connector-shopify/schemas` — [source](./src/schemas.ts).

## Workspace dependencies

[@luma/connector-core](../core/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/connector-shopify...
pnpm exec turbo run typecheck --filter=@luma/connector-shopify
pnpm exec turbo run test --filter=@luma/connector-shopify
```

## Further reading

- [Engineering guide](../../../docs/shopify.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
