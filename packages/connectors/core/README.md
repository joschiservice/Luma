# @luma/connector-core

Shared provider failure contracts and transport helpers for the Shopify and JTL protocol clients.

Provider-specific schemas belong in the provider packages and tenant permissions in connections. Exports point to compiled `dist` output.

## Public entry points

- `@luma/connector-core` — failure contracts and `ConnectorError`.
- `@luma/connector-core/transport` — response parsing and retry helpers.

## Further reading

- [Connectors](../../../docs/connectors.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
