# @luma/identity

Owns authentication, organizations, memberships, tenant context, and authorization guards.

## Responsibilities

The composition entry creates the identity service and owns its database pool; callers must close it. HTTP registration is separate. Keep identity credentials and database privileges separate from workflow persistence.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/identity` — [source](./src/index.ts).
- `@luma/identity/composition` — [source](./src/composition.ts).
- `@luma/identity/http` — [source](./src/http.ts).

## Workspace dependencies

[@luma/api-contract](../api-contract/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/identity...
pnpm exec turbo run typecheck --filter=@luma/identity
pnpm exec turbo run test --filter=@luma/identity
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Engineering guide](../../docs/identity.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
