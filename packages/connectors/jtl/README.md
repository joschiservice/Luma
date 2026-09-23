# @luma/connector-jtl

Provides JTL cloud and on-premise protocol clients and response schemas.

## Responsibilities

Supply credentials and transport explicitly. The caller must approve an on-premise destination before creating a client. Installation permissions, credential storage, and canonical mapping belong to connections.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/connector-jtl` — [source](./src/index.ts).
- `@luma/connector-jtl/schemas` — [source](./src/schemas.ts).

## Workspace dependencies

[@luma/connector-core](../core/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/connector-jtl...
pnpm exec turbo run typecheck --filter=@luma/connector-jtl
pnpm exec turbo run test --filter=@luma/connector-jtl
```

## Further reading

- [Engineering guide](../../../docs/jtl.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
