# @luma/simulator

Hosts simulated merchant runs: provider endpoints, the merchant world engine, failure injection, webhook delivery, ground-truth incidents, the scorecard and the control API.

## Responsibilities

The host stores runs in its own PostgreSQL database and coordinates the provider simulators. Provider protocol behavior belongs to the simulator provider packages, merchant profiles to `@luma/simulator-commerce`, failure decisions to `@luma/simulator-core`, and the control panel to `apps/simulator-web`.

## Entry points

- [src/server.ts](src/server.ts) — standalone service; requires `LUMA_SIMULATOR_DATABASE_URL`.
- [src/app.ts](src/app.ts) — `createApp`, used by `pnpm simulator` and tests.
- [src/migrate.ts](src/migrate.ts) and [migrations](migrations) — schema, applied with the owner connection.

## Workspace dependencies

[@luma/simulator-core](../../packages/simulator/core/README.md), [@luma/simulator-commerce](../../packages/simulator/commerce/README.md), [@luma/simulator-contract](../../packages/simulator/contract/README.md), [@luma/simulator-jtl](../../packages/simulator/jtl/README.md), [@luma/simulator-shopify](../../packages/simulator/shopify/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm simulator
pnpm simulator:service
pnpm test:simulator
pnpm exec turbo run typecheck --filter=@luma/simulator
```

Host tests that need PostgreSQL run through `pnpm test:simulator`, which provides a disposable server; without `TEST_DATABASE_URL` they are skipped.

## Further reading

- [Engineering guide](../../docs/simulator.md)
- [Adding an operational scenario](../../docs/adding-operational-scenarios.md)
