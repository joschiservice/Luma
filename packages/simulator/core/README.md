# @luma/simulator-core

What every simulated provider shares: the record store contract and in-memory store, the provider request protocol and fetch transport, deterministic randomness, failure profiles and presets, manual fault rules, rate-limit buckets and incident kinds.

Failure decisions depend only on a run's seed and the request identity, so runs repeat. Transport deadlines use real time. Provider records and protocol behavior belong to the Shopify and JTL simulator packages. Exports point to compiled `dist` output.

## Further reading

- [Simulator](../../../docs/simulator.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
