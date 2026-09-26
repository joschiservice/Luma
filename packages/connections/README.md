# @luma/connections

Manages installed connections, encrypted credentials, permissions, provider capabilities, and source observations.

## Responsibilities

This package owns connection permissions, encrypted credential storage, shared capability validation, and source observations. Apps supply provider-specific validation, credential refresh, and adapters through `ConnectionProvider`. OAuth, normalization, and setup UI live in `packages/apps/*`.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/connections` — [source](./src/index.ts).
- `@luma/connections/composition` — [source](./src/composition.ts).
- `@luma/connections/adapters` — [source](./src/adapters.ts).
- `@luma/connections/http` — [source](./src/http.ts).

## Workspace dependencies

[@luma/api-contract](../api-contract/README.md), [@luma/connector-core](../connectors/core/README.md), [@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/connections...
pnpm exec turbo run typecheck --filter=@luma/connections
pnpm exec turbo run test --filter=@luma/connections
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Engineering guide](../../docs/installed-connections.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
