# @luma/connections

Manages installed connections, encrypted credentials, permissions, provider capabilities and source observations.

Owns connection permissions, encrypted credential storage, shared capability validation and observation storage. Apps supply provider-specific validation, credential refresh and adapters through `ConnectionProvider`; OAuth, normalization and setup UI live in `packages/apps/*`.

## Public entry points

- `@luma/connections`
- `@luma/connections/composition`
- `@luma/connections/adapters`
- `@luma/connections/http`

## Further reading

- [Installed connections](../../docs/installed-connections.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
