# @luma/simulator

Hosts persistent simulator runs, provider endpoints, scheduling, and the control API.

## Responsibilities

The host coordinates provider simulators and persists run state in SQLite. Provider protocol behavior belongs to simulator packages; static control-panel assets belong to apps/simulator-web.

## Entry points

- [src/server.ts](src/server.ts)

## Workspace dependencies

[@luma/simulator-core](../../packages/simulator/core/README.md), [@luma/simulator-jtl](../../packages/simulator/jtl/README.md), [@luma/simulator-shopify](../../packages/simulator/shopify/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm simulator
pnpm test:simulator
pnpm exec turbo run build --filter=@luma/simulator...
pnpm exec turbo run typecheck --filter=@luma/simulator
pnpm exec turbo run test --filter=@luma/simulator
```

## Further reading

- [Engineering guide](../../docs/simulator.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
