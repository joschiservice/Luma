# @luma/web

The product UI: TanStack Start routes, feature UI, the workspace shell and the public MDX
product guides in `content/docs`. See the [README](README.md),
[shared frontend components](../../docs/frontend-ui.md) and
[documentation and contextual help](../../docs/contextual-help.md).

## Layers and structure

- `src` has four layers, and a module imports only its own layer or lower ones:
  `shell` → `features` → `shared` → `kit`. Features may use each other but never in a
  cycle; move the shared part down or let the shell supply it.
  `pnpm test:architecture` checks this.
- Features have no barrel `index.ts`, because a barrel pulls a feature's modules and CSS
  into every route that uses one export.
- A feature usually has `page.tsx`, `detail.tsx`, URL state in `data.ts` and wording in
  `presentation.ts`. Its stylesheet lays out shared components; it never restyles them.
- A new top-level page goes in `workspaceDestinations` in `src/shell/workspace-destinations.ts`.
  The sidebar, command menu, `G` shortcuts and the no-access explanation read it; a page
  missing there can't be reached by keyboard or search.
- The `typecheck` script regenerates `src/routeTree.gen.ts` with the Start plugin, as dev and
  build do; commit it, never edit it. CI fails when the committed tree is stale.

## State and data

- TanStack Router search params own shareable filters and views; don't mirror them into
  another store. TanStack Query owns server data; keep query keys, mutations and
  invalidation beside the feature.
- Never create a server `QueryClient` as a module singleton. The router creates one per
  request for SSR hydration.
- Match domain unions with `ts-pattern` `.exhaustive()`. Keep loading, stale, unavailable,
  failed and empty states distinct, and never show an accepted request as verified.
- Code here ships to the browser: no backend package imports or server credentials.

## Product guides

Guides in `content/docs` are public. Every guide must be listed in both `meta.json` and
`meta.de.json`, in the same order. A German translation sits beside its guide as
`<name>.de.mdx` and keeps the English heading IDs with `[#id]` suffixes. Help topics map to
existing English guides.

## Tests

`pnpm --filter @luma/web test <file>` runs the Node unit tests; stories in `src` run in
`pnpm test:ui`. Browser journeys in `apps/api/e2e` use a production build, so React
development checks don't run there.
