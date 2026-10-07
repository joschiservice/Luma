# @luma/ui

Luma's shared React components, semantic design tokens and stories. Owned source, initialized from shadcn's Base UI registry; `components.json` retains `base-nova` to select upstream source, while Luma's tokens and variants define the appearance. No router, server, auth or desktop bridge belongs here.

The [design workflow](../../docs/design-workflow.md) describes the Living Systems direction, where brand rules live and how to change tokens. In Storybook, `Foundations/Theme` shows the current tokens, operational states, domain landmarks, typography and marks. `App/Workspace shell` lives in `apps/web` and shows the production chrome with local navigation fixtures.

## Structure and rules

Components, stories and fixtures are grouped by responsibility under `src/components`:

- `primitives/`: general components such as Card, Alert, Button and Field. They never import feature components.
- `issues/`: issue investigation, evidence, execution, resolution and timeline compositions.
- `workspace/`: workspace header, switcher and account menu.

Import from the matching public path, such as `@luma/ui/components/primitives/card`. Keep stories and fixtures beside their components.

- Primitives never infer loading, data or business state. Callers supply `disabled`, `aria-busy` and content.
- StateDot and StatePill require a text label; color alone never carries an operational state.
- Consumers supply accessible labels and validation state for form controls. Connect labels with `htmlFor`, errors with `aria-describedby` and invalid inputs with `aria-invalid`.
- Use Base UI's `render` prop for composition, for example `DialogTrigger render={<Button />}`. Always include `DialogTitle` and a meaningful description.
- Use `buttonVariants()` on a real link for navigation so link semantics are preserved.
- `className` is for layout adjustments; visual changes belong in variants and semantic tokens. Use `cn` from `@luma/ui/lib/utils` to merge classes.
- Buttons default to 32px. Use `sm` (28px) in dense rows and toolbars, `lg` (40px) for sign-in and onboarding, and `icon` (32px) with an accessible label. Coarse pointers and narrow screens get 44px targets automatically.

## Styles and theming

`src/styles/globals.css` imports Tailwind v4, the bundled fonts and the stylesheet layers: `tokens.css` (brand, semantic, state and domain values for light and dark), `base.css`, `primitives.css`, `charts.css`, `workspace.css` and `issues.css`. It scans the component directory explicitly, so utilities are included wherever the host lives. There are no remote fonts or CDN assets.

Apply `.dark` to the document element so portals inherit the theme; each host owns the theme preference.

## Consume from React

Add `@luma/ui: workspace:*` and React 19 to the host, enable `@tailwindcss/vite` and import the stylesheet once:

```tsx
import '@luma/ui/styles.css';
import { Button } from '@luma/ui/components/primitives/button';
import { Spinner } from '@luma/ui/components/primitives/spinner';

<Button disabled aria-busy>
  <Spinner aria-hidden="true" data-icon="inline-start" />
  Save changes
</Button>;
```

Exports point to source, including types; the host compiles it.

## Add or change components

```sh
# From the repository root:
pnpm dlx shadcn@latest add <component> --cwd packages/ui --dry-run
pnpm dlx shadcn@latest add <component> --cwd packages/ui
```

Both this package's and the web app's `components.json` place new primitives in `primitives/`. Review new registry dependencies and source, adapt styling to Luma's tokens and add stories before use. For upstream updates, inspect `--diff` and merge deliberately; do not overwrite owned styling. Add package exports for new utility or hook directories.

Stories cover light and dark, disabled, invalid and pending states, keyboard interaction and dialog focus and dismissal. Accessibility failures fail `pnpm test:ui`, including portaled open dialogs.

`Examples/Validated contact form` shows the intended form pattern: TanStack Form, Zod Standard Schema validation, Query mutations and exhaustive `ts-pattern` result handling, focusing the first invalid field and preserving drafts after failures. It lives in `src/examples`, is excluded from the library build and is not a public component. Build feature forms in their owning app from the Field primitives.

## Further reading

- [Shared frontend components](../../docs/frontend-ui.md)
- [Design workflow](../../docs/design-workflow.md)
