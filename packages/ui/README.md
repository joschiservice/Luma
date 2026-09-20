# Luma UI

The [design workflow](../../docs/design-workflow.md) describes the Figma library,
token checks, story links, and AI-assisted iteration. `Foundations/Theme`
shows the current tokens in Storybook; the Designs addon displays linked Figma
frames alongside their stories.

`App/Workspace shell` shows the production sidebar, header, workspace switcher,
account menu, and mobile drawer. These stories live in `apps/web` and use local
navigation fixtures. Their app stylesheet is mounted only for the app stories.

Owned React source, initialized with shadcn's Base UI registry. `components.json` retains `base-nova` to select upstream source; Luma's tokens and variants define the appearance. No router, server, auth or desktop bridge belongs here.

## Starter surface

- **Button:** primary, outline, ghost and destructive actions; native keyboard behavior.
- **Input:** text entry with native/Base UI props; consumers supply accessible labels and validation state.
- **Dialog:** composable trigger, popup, title, description and close controls; Base UI owns focus and dismissal.
- **Field:** composable labels, descriptions and associated validation errors.
- **Spinner:** composable loading feedback with reduced-motion support.

Components and stories live together in `src/components`. `src/styles/globals.css` owns Tailwind v4, semantic colors, typography and radii. Warm paper, forest green and terracotta replace the neutral preset. The `.dark` token set uses the same component classes. Apply `.dark` to the document element so portals inherit the theme; each host owns the theme preference.

## Consume from React

Add `@luma/ui: workspace:*` and React 19 to the host. Enable `@tailwindcss/vite` in its Vite config and import the stylesheet once:

```tsx
import '@luma/ui/styles.css';
import { Button } from '@luma/ui/components/button';
import { Spinner } from '@luma/ui/components/spinner';

<Button disabled aria-busy>
  <Spinner aria-hidden="true" data-icon="inline-start" />
  Save changes
</Button>;
```

`@luma/ui/button` remains a compatibility import. The old `pending` prop is replaced by composition: the caller supplies `disabled`, `aria-busy`, and content. No loading, data or business state is inferred inside a primitive.

This setup is the same for TanStack Start and a future Tauri + React/Vite frontend. Package exports point to source, including their TypeScript types; the host compiles it. The shared CSS explicitly scans the UI component directory, so utilities are included even when the host lives elsewhere. There are no remote fonts or CDN runtime assets. Tauri commands, permissions and OS integration stay in the desktop host. A native Tauri shell is not part of this package.

Use Base UI's `render` prop for composition, for example `DialogTrigger render={<Button />}`. Always include `DialogTitle` and a meaningful description. Use `buttonVariants()` on an actual link for navigation so link semantics are preserved. `className` supports layout adjustments; visual changes belong in variants and semantic tokens.

## Add or change components

```sh
# From the repository root:
pnpm dlx shadcn@latest add <component> --cwd packages/ui --dry-run
pnpm dlx shadcn@latest add <component> --cwd packages/ui
```

The web app's `components.json` also routes shared primitives into this package. Review new registry dependencies and source, adapt styling to Luma's tokens, and add stories before use. For upstream updates, inspect `--diff` and merge intentionally; do not overwrite owned styling. Add exports for new utility/hook directories when needed. `cn` is exposed through `lib/utils.ts` for consistent class merging.

`pnpm storybook`, `pnpm test:ui` and `pnpm build:storybook` run the workshop. Stories cover light/dark, disabled/invalid/pending states, keyboard interaction and dialog focus/dismissal. Accessibility failures fail tests, including the portaled open dialog. Theme selection is built into the toolbar without an additional addon. The web package also checks server rendering through public UI imports.

## Validated form example

`Examples/Validated contact form` composes TanStack Form, direct Zod Standard Schema validation, Query mutations and exhaustive `ts-pattern` result handling. The host supplies the save function; story fixtures provide deterministic results. The example lives in `src/examples`, is excluded from the library build, and is not a public component or production contract.

Reuse the small Field primitives, not an application-wide form abstraction. Connect labels with `htmlFor`, errors with `aria-describedby` and invalid inputs with `aria-invalid`. The example focuses the first invalid field, preserves drafts after failures, disables pending submissions and announces results. Browser tests cover normalization, rejected submissions, retry, unknown response validation and accessibility. Add feature forms in their owning app; extract reusable UI only when needed.
