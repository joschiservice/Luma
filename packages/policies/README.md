# @luma/policies

Evaluates action policy and approval requirements and persists policy decisions.

## Responsibilities

Policy evaluation uses current identity and action evidence. Execution consumes the decision and performs effects; audit recording is supplied through a dependency. Keep approval semantics here so all callers apply the same rules.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/policies` — [source](./src/index.ts).
- `@luma/policies/composition` — [source](./src/composition.ts).

## Workspace dependencies

[@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/policies...
pnpm exec turbo run typecheck --filter=@luma/policies
pnpm exec turbo run test --filter=@luma/policies
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Engineering guide](../../docs/case-decisions.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
