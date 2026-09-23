# @luma/simulator-core

Provides the simulator clock, event journal, scheduling, fault handling, and in-process HTTP transport.

## Responsibilities

Keep simulated time deterministic and separate from real transport timeouts. Provider-specific state and protocol behavior belong to the Shopify and JTL simulator packages.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/simulator-core` — [source](./src/index.ts).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/simulator-core...
pnpm exec turbo run typecheck --filter=@luma/simulator-core
pnpm exec turbo run test --filter=@luma/simulator-core
```

## Further reading

- [Engineering guide](../../../docs/simulator.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
