# @luma/web

The Luma browser application, built with React and TanStack Start.

Routes live in `src/routes` and feature UI in `src/features`. Shared presentational components belong to `@luma/ui`, and HTTP calls go through `@luma/api-contract`. Keep backend implementation imports and server credentials out of browser code; `VITE_*` values are public. `src/routeTree.gen.ts` is generated; regenerate it instead of editing it. Public product guides live in `content/docs`.

## Further reading

- [Shared frontend components](../../docs/frontend-ui.md)
- [Local development](../../docs/development.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
