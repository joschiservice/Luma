# @luma/ui

Shared React components, semantic design tokens and their stories. The [README](README.md)
holds the component rules and the shadcn workflow; read it before adding or changing a
component. Choice of component and composition rules are in
[shared frontend components](../../docs/frontend-ui.md); tokens and brand rules in the
[design workflow](../../docs/design-workflow.md).

## Boundaries

- `primitives/` never import `issues/` or `workspace/` compositions, and nothing here
  imports from `apps/*`: no router, server, auth, data fetching or business decisions.
  Callers pass state, labels and content through props.
- Built-in component text, such as a dialog's close label or pagination's range, comes from
  the `ui_*` and `common_*` messages in `@luma/i18n`; numbers go through its format
  helpers. Domain wording comes from the caller.
- Case states map through `issueStatus` and `issueKind` in
  `src/components/issues/case-presentation.ts`, not per feature.
- Appearance lives here, in variants and semantic tokens under `src/styles`. A consumer's
  need for a different look is a new variant, not a page-level override.
- Shipping owned shadcn source means updates are merged by hand. Never re-run `add` over an
  existing component without reviewing `--diff`; it overwrites Luma's styling.

## Stories are the component tests

- Components are tested through their stories in Chromium: Storybook play functions and
  accessibility checks. Only pure helpers have Node `*.test.ts` files.
- Every new component needs stories for light and dark, disabled, invalid and pending
  states, keyboard interaction and, for dialogs, focus and dismissal. Keep fixtures beside
  the component and deterministic.
- Storybook also loads stories from `apps/web/src`, so `pnpm test:ui` covers web stories
  too, and a change here can fail a web story.
- `pnpm lint:ui` and `pnpm lint` reject literal colors and appearance overrides on shared
  primitives. Existing violations are pinned in `tooling/style/ui-baseline.json`; remove an
  entry when you fix it, never add one.
