# @luma/api

Runs the Luma HTTP API process.

## Responsibilities

The bootstrap initializes instrumentation and starts application-runtime. Keep service assembly in application-runtime, HTTP contracts in api-contract, and domain rules in their owning packages.

## Entry points

- [src/composition/bootstrap.ts](src/composition/bootstrap.ts)
- [src/index.ts](src/index.ts)

## Workspace dependencies

[@luma/application-runtime](../../packages/application-runtime/README.md), [@luma/config](../../packages/config/README.md), [@luma/platform](../../packages/platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm dev
pnpm test:e2e
pnpm exec turbo run build --filter=@luma/api...
pnpm exec turbo run typecheck --filter=@luma/api
pnpm exec turbo run test --filter=@luma/api
```

## Further reading

- [Engineering guide](../../docs/api.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
