# @luma/web

Runs the Luma browser application using React and TanStack Start.

## Responsibilities

Routes and feature interactions live here. Shared presentational components belong to ui, and HTTP calls use api-contract. Keep backend implementation imports and server credentials out of browser code. Route-tree output is generated.

## Entry points

- [src/routes](src/routes)

## Workspace dependencies

[@luma/api-contract](../../packages/api-contract/README.md), [@luma/ui](../../packages/ui/README.md).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm dev
pnpm test:browser
pnpm exec turbo run build --filter=@luma/web...
pnpm exec turbo run typecheck --filter=@luma/web
pnpm exec turbo run test --filter=@luma/web
```

## Further reading

- [Engineering guide](../../docs/development.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
