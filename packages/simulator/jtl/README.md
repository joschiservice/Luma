# @luma/simulator-jtl

Models JTL provider state, fixture commands, and protocol responses for simulation.

## Responsibilities

Use simulator-core for time, events, and transport. Keep state provider-shaped; canonical Luma models and cross-provider scenario orchestration belong outside this package.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/simulator-jtl` — [source](./src/index.ts).

## Workspace dependencies

[@luma/simulator-core](../core/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/simulator-jtl...
pnpm exec turbo run typecheck --filter=@luma/simulator-jtl
pnpm exec turbo run test --filter=@luma/simulator-jtl
```

## Further reading

- [Engineering guide](../../../docs/simulator.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
