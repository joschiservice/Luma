# Luma design workflow

Code and Storybook are the source of truth for Luma's interface. Designs are implemented in `@luma/ui` and the web app, reviewed in Storybook in both themes, and checked in the running app for integrated journeys. Component rules are in [shared frontend components](frontend-ui.md).

## Brand sources

Luma follows Auren's **Living Systems** direction: precise geometry, visible states, subtle depth and productivity first. The rules come from three places:

- Notion **Luma — Product Design System**: workspace structure, density, navigation, the inspector, natural language and the attention Home.
- Notion **Auren — Visual Identity**: shared colors, typography, marks and motion.
- The `auren-guides` repository: voice, wording and conventions. Where Notion and the guide disagree on wording, the guide wins.

The `auren-labs-website` repository uses the same tokens and marks on the marketing site. Keep product and website tokens aligned.

## Product principles

- **Workspace first.** Apps, views, records, queues and split views. Chat and generated UI support the workspace; they don't replace it.
- **Compact by default.** 14px body text, 13px secondary text and 12px metadata. Rows, toolbars and inspectors before cards; cards group content that needs a boundary, such as Home modules and record sections.
- **State is always visible.** Brand blue marks active work and focus. It never replaces the success, approval, warning or error colors, and every state has a text label.
- **Landmarks, not decoration.** Operational domains get a recognizable tile in navigation and records. External systems stay neutral.
- **Motion shows change.** Fades and the running pulse are short and respect reduced motion. Menus close instantly after a choice.
- **Light and dark are equal.** Both themes are calibrated separately and follow the system setting unless a person chooses otherwise.

## Tokens

`packages/ui/src/styles/tokens.css` defines the brand foundation (Canvas, Graphite, Deep Surface, Midnight, Cobalt, Azure), semantic surfaces and text, operational states, domain and chart colors, radii, shadows and motion. Instrument Sans is the only interface typeface; IBM Plex Mono is for identifiers and code.

The brand values are working tokens. To change one:

1. Update `tokens.css` for both themes.
2. Check text contrast against every surface it appears on, including tinted state backgrounds. Body and metadata text must reach 4.5:1.
3. Review **Foundations/Theme** and the affected feature stories in both themes.
4. Run `pnpm test:ui`. Storybook's accessibility checks run as errors, so contrast regressions fail.

## Review process

- Build and review component states in Storybook (`pnpm storybook`). **Foundations/Theme** shows tokens, states, domain landmarks, typography and marks; feature stories cover domain compositions in both themes and at narrow widths.
- Stories don't exercise authentication, routing, live data or personal layouts. Review those journeys in the app, using the [synthetic pilot](pilot-environment.md) or the [simulator](simulator.md) for realistic issues, approvals and connections.
- Figma is optional for explorations. There is no Figma library or token snapshot to keep in sync; implement and review the result in Storybook.

## Website screenshots

The product screenshots on the Auren website come from the **Marketing/Screenshots** stories: the real Home, Needs you and order record pages with hand-made sample data for one fictional workspace. Data that isn't in the message catalogs, such as decision titles and product names, is written in English and German so each language gets its own screenshot.

`pnpm screenshots:marketing --out <website>/public/images/luma` builds Storybook, then captures every screen in both languages with a frozen clock, the workspace time zone and reduced motion, so reruns only change when the interface does. Pass `--skip-build` to reuse an existing `packages/ui/storybook-static` build. Each screen's viewport and scale produce the pixel size of its image slot on the website; change both together.

When a page in these stories changes, rerun the script and review the images before committing them to the website. Keep the sample data consistent with the website's example (order 48213 on a fulfillment hold) and within what Luma does today.
