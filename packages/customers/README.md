# @luma/customers

Owns imported customer profiles: the current profile each connection reports for a source
customer.

## Responsibilities

Profiles keep only the latest accepted source version, so erasure removes the data
completely. They are never merged across connections; names and email addresses do not
establish identity. Provider payload translation belongs to connections and scheduling to
commerce-sync.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/customers` — [source](./src/index.ts).
- `@luma/customers/composition` — [source](./src/composition.ts).

## Workspace dependencies

[@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/customers...
pnpm exec turbo run typecheck --filter=@luma/customers
pnpm exec turbo run test --filter=@luma/customers
```

## Further reading

- [Commerce sync](../../docs/commerce-sync.md)
