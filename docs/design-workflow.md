# Luma design workflow

Code and Storybook are the source of truth for Luma's interface. Production UI
lives in `packages/ui` and `apps/web`; Storybook shows every implemented state in
both themes and runs accessibility checks.

## Brand and product direction

Luma follows Auren's **Living Systems** direction: precise geometry, visible
states, subtle depth and productivity first. The rules come from three places:

- Notion **Luma — Product Design System**: workspace structure, density,
  navigation, the inspector, natural language and the attention Home.
- Notion **Auren — Visual Identity**: shared colors, typography, marks and
  motion.
- The `auren-guides` repository: voice, wording and conventions. Where Notion
  and the guide disagree on wording, the guide wins.

The `auren-labs-website` repository shows the same tokens, marks and product
visuals on the marketing site. Keep product and website tokens aligned.

## What the product should feel like

- **Workspace first.** Apps, views, records, queues and split views. Chat and
  generated UI support the workspace; they don't replace it.
- **Compact by default.** 14px body text, 13px secondary text and 12px metadata.
  Rows, toolbars and inspectors before cards. Cards group content that needs a
  boundary, such as Home modules and record sections.
- **State is always visible.** `StateDot` and `StatePill` show where work stands.
  Brand blue marks active work and focus; it never replaces the success,
  approval, warning or error colors, and every state has a text label.
- **Landmarks, not decoration.** `DomainIcon` gives operational domains a
  recognizable tile in navigation and records. External systems stay neutral.
- **Motion shows change.** Fades and the running pulse are short and respect
  reduced motion. Menus close instantly after a choice.
- **Light and dark are equal.** Both themes are calibrated separately and follow
  the system setting unless a person chooses otherwise in Settings.

## Tokens

`packages/ui/src/styles/tokens.css` defines the brand foundation (Canvas,
Graphite, Deep Surface, Midnight, Cobalt, Azure), semantic surfaces and text,
operational states, domain colors, radii, shadows and motion. Components and
feature stylesheets read semantic names only. Instrument Sans is the single
interface typeface; IBM Plex Mono is used for identifiers and code.

The brand values are working tokens. To change one:

1. Update `tokens.css` for both themes.
2. Check text contrast against every surface it appears on, including tinted
   state backgrounds. Body and metadata text must reach 4.5:1.
3. Review `Foundations/Theme` and the affected feature stories in both themes.
4. Run `pnpm test:ui`; its accessibility checks fail on contrast regressions.

## Stylesheet structure

| Layer                | File                                    | Owns                                                      |
| -------------------- | --------------------------------------- | --------------------------------------------------------- |
| Tokens               | `packages/ui/src/styles/tokens.css`     | Brand, semantic, state and domain values                  |
| Base                 | `packages/ui/src/styles/base.css`       | Document defaults, focus, text roles, keyframes           |
| Primitives           | `packages/ui/src/styles/primitives.css` | Menus, marks, states, domain icons, cards, alerts, badges |
| Workspace and issues | `workspace.css`, `issues.css`           | Section workspace, inbox, inspector and issue records     |
| Shell and pages      | `apps/web/src/styles/*.css`             | Sidebar, top bar, page chrome, entry pages                |
| Features             | `apps/web/src/features/*/*.css`         | Layout and presentation of one feature                    |

Feature stylesheets are imported by the feature's page component. They may lay
out shared components but don't restyle their surfaces, colors or type.

## Local workshop

```sh
pnpm storybook
pnpm test:ui
pnpm build:storybook
```

Storybook runs at `http://localhost:6006`. `Foundations/Theme` shows the tokens,
states, domain landmarks, typography and marks. `App/Workspace shell` uses the
production `WorkspaceLayout` with fixture navigation. Feature stories cover the
issue inbox and full page, workflows, activity, settings and Shadow evaluation.

Review the whole journey in the app as well: stories don't exercise
authentication, routing, live data or personal layouts. The
[synthetic pilot](pilot-environment.md) provides realistic issues, approvals and
connections.

## Figma

The Figma library and its token snapshot check were retired with the Living
Systems overhaul. Use Figma for explorations if helpful, then implement and
review the result in Storybook.
