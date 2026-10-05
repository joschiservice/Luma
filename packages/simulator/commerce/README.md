# @luma/simulator-commerce

Describes simulated merchants: profiles, generated catalogs with stock and suppliers, demand curves, baskets and synthetic customers.

## Responsibilities

Everything here is a pure function of a profile and a seed. The simulator host turns it into provider records and scheduled merchant activity. Provider protocols belong to the provider packages.

## Public entry points

- `@luma/simulator-commerce` — [source](./src/index.ts): `merchantProfiles`, `generateCatalog`, `orderRate`, `createAssortment`, `customer`.

## Development

```sh
pnpm exec turbo run test --filter=@luma/simulator-commerce
```

## Further reading

- [Engineering guide](../../../docs/simulator.md)
