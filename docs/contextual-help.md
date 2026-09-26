# Documentation and contextual help

User guides live in `apps/web/content/docs`. Fumadocs MDX compiles them into lazy
React articles. Fumadocs Core supplies the content source, heading metadata, and
full-text search. The portal and help drawer render the same articles with Luma's
shared controls and semantic colors.

- `/docs` opens the issue guide. `/docs/<slug>` is the canonical article URL.
- `/docs-search` serves the Fumadocs search API through TanStack Start. It sits
  outside `/api`, which Vite forwards to the application backend.
- Both endpoints are public. Only put public product guidance in this collection.
- Workspace routes opt into help through `staticData.help`. The deepest matched
  route with a topic wins. Add topic slugs to `HelpTopic` in
  `apps/web/src/features/help/context.ts`.
- The inbox opens `issues`; selected issues and full issue pages open
  `issues/investigate`. The resolution guide is available through links and search.

Write task-focused MDX with a `title` and `description` in frontmatter. Use `##`
headings and canonical links such as `/docs/issues/resolve#confirm-the-outcome`.
The drawer prefixes heading IDs and handles navigation locally so opening a
guide cannot change the selected issue, filters, or browser history. Modified
clicks and “Open full documentation” retain normal link behavior.

Fumadocs' Vite plugin is configured in both the web build and Vitest. Guides are
loaded on demand. Search indexes the same content on the server. The portal uses
server rendering; search is enabled when the browser has hydrated.

## Validation

`pnpm --filter @luma/web test` covers topic resolution and route behavior.
`pnpm --filter @luma/api test:browser docs.browser.mjs` covers the public portal
without a database. `pnpm test:browser issues-help.browser.mjs` covers contextual help
on authenticated issue pages, local article navigation, heading focus, opening
the portal, Escape dismissal, retained issue state, and mobile rendering.
