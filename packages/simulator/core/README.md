# @luma/simulator-core

Provides what every simulated provider shares: the record store contract and in-memory store, the provider request protocol and fetch transport, deterministic randomness, failure profiles and presets, manual fault rules, rate-limit buckets and incident kinds.

## Responsibilities

Failure decisions depend only on a run's seed and the request identity, so runs repeat. Transport deadlines use real time. Provider records and protocol behavior belong to the Shopify and JTL simulator packages.

## Public entry points

Import through the package export. Private source paths are not supported across package boundaries.

- `@luma/simulator-core` — [source](./src/index.ts).

## Development

```sh
pnpm exec turbo run test --filter=@luma/simulator-core
```

## Further reading

- [Engineering guide](../../../docs/simulator.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
