# Documentation and contextual help

Product guides in `apps/web/content/docs` are compiled by Fumadocs MDX into lazily loaded articles. The public portal at `/docs` and the in-app help drawer render the same articles with Luma's shared components. Opening help never changes the workspace state behind it.

## Rules

- The portal and its search endpoint are public. Only put public product guidance in this collection; contributor and implementation notes belong in `docs/`.
- `/docs/<slug>` is the canonical article URL; `/docs` redirects to the issue guide. Search is served at `/docs-search`, outside `/api`, because Vite forwards `/api` to the backend.
- Workspace routes opt into help with `staticData.help`. The deepest matched route with a topic wins. Add new topics to the `HelpTopic` type in the web help feature.
- Write task-focused MDX with `title` and `description` frontmatter and `##` headings. Link with canonical paths such as `/docs/issues/resolve#confirm-the-outcome`; the drawer handles only same-origin `/docs/...` links locally.

## Drawer behavior

The drawer prefixes heading IDs and handles article links locally, so following a link cannot change the selected issue, filters or browser history. Modified clicks and **Open full documentation** keep normal link behavior.

The portal is server-rendered; search starts working once the browser has hydrated. Search indexes the same content on the server. The Fumadocs Vite plugin is configured in both the web build and Vitest, so article imports also work in tests.
