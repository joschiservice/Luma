# @luma/exceptions

Detects and persists operational exceptions, their evidence, diagnoses, verification, and escalation state.

## Responsibilities

Keep detection and diagnosis rules here. Provider access is injected through application contracts. Proposal review and playbook execution belong to resolution and execution.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/exceptions` — [source](./src/index.ts).
- `@luma/exceptions/composition` — [source](./src/composition.ts).
- `@luma/exceptions/http` — [source](./src/http.ts).

## Workspace dependencies

[@luma/api-contract](../api-contract/README.md), [@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/exceptions...
pnpm exec turbo run typecheck --filter=@luma/exceptions
pnpm exec turbo run test --filter=@luma/exceptions
```

Use `pnpm test` for cross-package integration coverage, including the application-runtime tests backed by disposable PostgreSQL.

## Further reading

- [Engineering guide](../../docs/exception-detection.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
