# @luma/commerce-sync

Imports connected commerce history, keeps it current and reconciles it against each source.

## Responsibilities

Owns sync streams (one per connection and record type), their checkpoints and runs, the
import ledger, and requests to link or unlink source SKUs and locations. It reads through
installed connection capabilities, projects through commerce-ingestion and stores customer
profiles through customers. It never writes to a source.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/commerce-sync` — [source](./src/index.ts).
- `@luma/commerce-sync/composition` — [source](./src/composition.ts).
- `@luma/commerce-sync/http` — [source](./src/http.ts).

## Workspace dependencies

[@luma/api-contract](../api-contract/README.md), [@luma/commerce-ingestion](../commerce-ingestion/README.md),
[@luma/connections](../connections/README.md), [@luma/customers](../customers/README.md),
[@luma/identity](../identity/README.md), [@luma/platform](../platform/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/commerce-sync...
pnpm exec turbo run typecheck --filter=@luma/commerce-sync
pnpm exec turbo run test --filter=@luma/commerce-sync
```

## Further reading

- [Commerce sync](../../docs/commerce-sync.md)
