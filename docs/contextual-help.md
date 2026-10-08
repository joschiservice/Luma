# Documentation and contextual help

Product guides in `apps/web/content/docs` are compiled by Fumadocs MDX into lazily loaded articles. The public portal at `/docs` and the in-app help drawer render the same articles with Luma's shared components, in the reader's interface language. Opening help never changes the workspace state behind it.

## Rules

- The portal and its search endpoint are public. Only put public product guidance in this collection; contributor and implementation notes belong in `docs/`.
- `/docs/<slug>` is the canonical article URL in every language; the language comes from the interface language (the `luma_locale` cookie, then the browser's languages), never from the path. `/docs` is the overview of all sections. Search is served at `/docs-search`, outside `/api`, because Vite forwards `/api` to the backend.
- Workspace routes opt into help with `staticData.help`. The deepest matched route with a topic wins. Add new topics to `helpTopics` in the web help feature; each topic must be an existing English guide.
- Write task-focused MDX with `title` and `description` frontmatter and `##` headings. Link with canonical paths such as `/docs/issues/resolve#confirm-the-outcome`; the drawer handles only same-origin `/docs/...` links locally.

## Navigation sections

The root `meta.json` orders every guide into sections: a `---Section title---` entry starts a section, and each following entry is a guide slug until the next one. URLs stay flat; a section is navigation only. The portal sidebar, the overview, the drawer's guide list, the article eyebrow and search breadcrumbs all read this structure, and sections without guides are hidden.

- A guide missing from `meta.json` still has a URL but appears in no navigation. A test requires every guide to be listed.
- Reference a guide that also has a same-named folder, such as `issues.mdx` beside `issues/`, with its file name. A bare `issues` resolves to the folder and drops the guide.
- `meta.de.json` holds the German section titles and must list the same guides in the same order. Fumadocs replaces the whole file per language rather than merging it, so a guide added only to `meta.json` disappears from German navigation; the test catches this.

## Translations

A translation sits beside its English guide with the language before the extension: `orders.de.mdx` next to `orders.mdx`, `issues/resolve.de.mdx` next to `issues/resolve.mdx`. English is the fallback. Without a translation, a German reader gets the English article marked as English for assistive technology, with a note that the guide isn't available in German yet.

- Keep the English heading IDs in a translation by ending each heading with a custom ID, for example `## Ergebnis bestätigen [#confirm-the-outcome]`. Links from other guides and from the app use those anchors; a translated heading otherwise gets a German ID and the links stop scrolling to it.
- Link to canonical paths in translations too. The reader stays in their language.

## Search

One index holds every language. Each guide is indexed once per interface language, using its translation where one exists and the English text otherwise, and queries are filtered to the reader's language. The client sends its language; requests without a supported one use the request's interface language.

The installed search engine tokenizes all languages with Unicode word segmentation and ignores diacritics, but it has no German stemming: a German query matches words and their beginnings, not other inflections ("Bestellung" finds "Bestellungen", not the reverse).

## Drawer behavior

The drawer prefixes heading IDs and handles article links locally, so following a link cannot change the selected issue, filters or browser history. Modified clicks and **Open full documentation** keep normal link behavior.

The portal is server-rendered; search starts working once the browser has hydrated. Search indexes the same content on the server. The Fumadocs Vite plugin is configured in both the web build and Vitest, so article imports also work in tests.
