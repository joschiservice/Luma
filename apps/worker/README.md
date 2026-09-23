# @luma/worker

Runs the Temporal worker process for exception resolution.

## Responsibilities

The bootstrap initializes instrumentation and starts the shared worker runtime. The default runtime disables provider writes; effects require explicit configuration. Keep workflow implementation in workflow-temporal and service assembly in application-runtime.

## Entry points

- [src/bootstrap.ts](src/bootstrap.ts)
- [src/index.ts](src/index.ts)

## Workspace dependencies

[@luma/application-runtime](../../packages/application-runtime/README.md), [@luma/config](../../packages/config/README.md), [@luma/platform](../../packages/platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm dev:workflows
pnpm exec turbo run build --filter=@luma/worker...
pnpm exec turbo run typecheck --filter=@luma/worker
pnpm exec turbo run test --filter=@luma/worker
```

## Further reading

- [Engineering guide](../../docs/exception-workflows.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
