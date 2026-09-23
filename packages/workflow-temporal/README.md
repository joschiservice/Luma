# @luma/workflow-temporal

Adapts resolution workflows to Temporal clients, workers, activities, and deterministic workflow execution.

## Responsibilities

Keep workflow code deterministic and perform external I/O through activities. Business orchestration contracts belong to resolution; process configuration and resource ownership belong to application-runtime and apps/worker.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/workflow-temporal` — [source](./src/index.ts).

## Workspace dependencies

[@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md), [@luma/resolution](../resolution/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/workflow-temporal...
pnpm exec turbo run typecheck --filter=@luma/workflow-temporal
pnpm exec turbo run test --filter=@luma/workflow-temporal
```

## Further reading

- [Engineering guide](../../docs/exception-workflows.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
