# @luma/resolution

Coordinates exception resolution: proposals, review, refresh, playbooks, learning, activity, and operational views.

## Responsibilities

Application orchestration depends on domain contracts. Temporal-specific behavior belongs to workflow-temporal. Proposal refresh rereads current evidence; synthetic identifiers and scenario faults stay in simulator tooling.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/resolution` — [source](./src/index.ts).
- `@luma/resolution/composition` — [source](./src/composition.ts).
- `@luma/resolution/http` — [source](./src/http.ts).

## Workspace dependencies

[@luma/api-contract](../api-contract/README.md), [@luma/connections](../connections/README.md), [@luma/exceptions](../exceptions/README.md), [@luma/execution](../execution/README.md), [@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md), [@luma/policies](../policies/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/resolution...
pnpm exec turbo run typecheck --filter=@luma/resolution
pnpm exec turbo run test --filter=@luma/resolution
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Engineering guide](../../docs/resolution-playbooks.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
