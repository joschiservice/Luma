# @luma/connector-core

Defines shared provider failures and transport helpers used by the Shopify and JTL clients.

## Responsibilities

The root exposes failure contracts and ConnectorError. Response parsing and retry helpers are available through /transport. Keep provider-specific schemas in the provider packages and tenant permissions in connections.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/connector-core` — [source](./src/index.ts).
- `@luma/connector-core/transport` — [source](./src/transport.ts).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/connector-core...
pnpm exec turbo run typecheck --filter=@luma/connector-core
pnpm exec turbo run test --filter=@luma/connector-core
```

## Further reading

- [Engineering guide](../../../docs/connectors.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
