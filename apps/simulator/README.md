# @luma/simulator

Hosts simulated merchant runs: provider endpoints, the merchant world engine, failure injection, webhook delivery, ground-truth incidents, the scorecard and the control API.

The host stores runs in its own PostgreSQL database, migrated from [migrations](migrations) with the owner connection. Provider protocol behavior belongs to the simulator provider packages, merchant profiles to `@luma/simulator-commerce`, failure decisions to `@luma/simulator-core` and the control panel to `apps/simulator-web`.

`src/server.ts` is the standalone service and requires `LUMA_SIMULATOR_DATABASE_URL`; `pnpm simulator:service` provisions it. `pnpm simulator` and tests use `createApp` from `src/app.ts`. Host tests that need PostgreSQL run through `pnpm test:simulator`, which provides a disposable server; without `TEST_DATABASE_URL` they are skipped.

## Further reading

- [Simulator](../../docs/simulator.md)
- [Adding an operational scenario](../../.agents/skills/add-operational-scenario/SKILL.md)
