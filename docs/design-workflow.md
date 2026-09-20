# Luma design workflow

Use Figma for layouts and design review, and Storybook for implemented states and
interactions. Production UI lives in `packages/ui` and `apps/web`.

## Current design revision

The app implements the published Issues revision from Product (`28:456` light,
`28:630` dark): Inter typography, cool semantic colors, summary cards, compact
issue rows, pagination, and the unified workspace/account control. Storybook has
light, dark, inbox-only and mobile workspace fixtures. The app follows the system
color preference and updates when that preference changes.

`design/figma-materials.json` records the Figma materials. Browser glass uses
translucent surfaces and backdrop blur; the sidebar uses the static spectral
composition. The native Figma shader source remains in
`design/shaders/spectral-light.figma.txt` and is not executed in the browser.

Summary cards use real API counts. “Verified · 24h” is a rolling window;
“Open issues” includes all active issues. Cursor pagination returns a filtered total and current offset from the same
database snapshot, so the interface shows the range and current page out of the
total page count. The inspector retains the full evidence and resolution
workflow. Source quantities remain in the evidence supplied by the API; only
structured exposure quantities appear as numeric callouts. Search opens a page
navigator with the keyboard shortcut Cmd/Ctrl K.

## Files and ownership

- [Luma · Design System](https://www.figma.com/design/FL0admcBfIIeypblAGGogm):
  published team library with light/dark variables, typography, core UI
  components, sidebar, header, responsive shell and navigation drawer.
- [Luma · Product](https://www.figma.com/design/gAaPhosEb2613OeFbHO6Kg):
  linked shell fixtures, a mobile navigation prototype, an editable screen
  template, an exception-journey review guide and an Explorations page.

Keep shared primitives in Design System and feature layouts in Product. Product
uses published instances and variables from the library. Accept library updates
after publishing shared changes.

The core library covers Button, Input, Field, Dialog, Spinner and the workspace
shell. Domain components such as investigation, resolution review and execution
timeline remain implemented in Storybook; the Product journey guide identifies
their fixtures for further screen design.

## Local workshop

```sh
pnpm storybook
pnpm design:check
pnpm test:ui
pnpm build:storybook
```

Storybook runs at `http://localhost:6006`. The Designs panel opens the corresponding
Figma selection. References live in `packages/ui/src/lib/figma.ts`; component
keys and source mappings are recorded in `design/figma-manifest.json`.

`Foundations/Theme` renders the CSS colors, typography and radii in both themes.
`UI/Field` shows labeled, invalid and disabled inputs. `App/Workspace shell`
uses the production `WorkspaceLayout` with deterministic navigation and account
fixtures. Desktop, Dark, Mobile, MobileDrawer and LongNames each link to their
own Figma frame.

The static build is written to `packages/ui/storybook-static`. No shared
Storybook host is configured. Deploy that directory to the team's chosen host,
then add stable story URLs to Figma development resources. Local URLs are only
for the local workshop.

## Fonts and tokens

The app bundles **Inter** for interface text and **IBM Plex Mono** for numerical
readouts through Fontsource. Light and dark semantic colors, including glass and
status surfaces, match the published Figma export. Spacing and radius bindings
keep Figma component layouts editable.

`design/figma-tokens.json` is a verified export of the Figma semantic colors and
font choices. `pnpm design:check` compares it with CSS, including inherited dark
values and newly added color tokens. The check runs in CI. It detects divergence
from the recorded snapshot; it does not contact Figma or synchronize edits.

When changing tokens:

1. Update the CSS and the corresponding Figma variables deliberately.
2. Check light/dark surfaces and dependent component states.
3. Publish the library and apply its updates in Product.
4. Export the verified Figma Color values for each mode into
   `design/figma-tokens.json`, resolving primitive aliases to hex colors.
   Preserve alpha, including transparent borders.
5. Run `pnpm design:check`, UI tests and the Storybook build.

Do not regenerate the snapshot from CSS alone: that would bypass the comparison.

## Design and implementation

Duplicate the **Design workspace** template into **Explorations**. Its sidebar
and header are linked instances; its content area is native Auto Layout that can
accept new sections. Keep reference fixtures on the App shell page.

Buttons have four appearances and three sizes matching React. Their Figma sets
split by appearance to keep interaction-state matrices readable. Pending is a
composition of a disabled Button, Spinner and busy/status semantics, not a new
React variant prop.

Use the Figma MCP connection for bounded edits and implementation handoff:

> In this Product frame, create two alternatives for the investigation and
> approval layout. Use the Luma library. Preserve evidence, proposed action,
> permissions and execution states from the supplied Storybook fixtures.
> Include mobile, loading and permission-loss states.

For implementation:

> Implement this Figma selection with existing @luma/ui components and semantic
> tokens. Preserve Base UI keyboard and focus behavior and the existing API
> contracts. Update the matching stories and verify the complete app flow.

Figma Make is useful for disposable interactive explorations. Its generated
prototype does not automatically become production React or stay synchronized
with this repository. An npm-based Make kit would need separate packaging of the
private workspace package.

## Exception journey references

| Step              | Story IDs                                                                  |
| ----------------- | -------------------------------------------------------------------------- |
| Overview          | `operations-overview--attention-needed`, `--onboarding`, `--stale`         |
| Investigation     | `cases-investigation--inventory`, `--pending`                              |
| Resolution review | `cases-resolution-review--approval-required`, `--permission-lost`          |
| Execution         | `cases-execution-timeline--executing`, `--verified-resolution`, `--failed` |

Open a story alone at
`http://localhost:6006/iframe.html?id=STORY_ID&viewMode=story`.
Review the inbox and full navigation journey in the app as well: shell fixtures
do not exercise authentication, production routing or live data.

## Code Connect

The current Figma Professional plan does not include Code Connect. The repository
therefore uses real Figma selection links and a component manifest. These provide
navigation and traceability, not Dev Mode code snippets or bidirectional sync.

If an eligible plan is adopted, map the published component keys with Code Connect
template files. Use the maintained template workflow, not the retired
Storybook-specific parser.

## References

- [Figma code to canvas](https://developers.figma.com/docs/figma-mcp-server/code-to-canvas/)
- [Figma write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/)
- [Storybook Designs addon](https://storybook.js.org/addons/@storybook/addon-designs)
- [Code Connect](https://developers.figma.com/docs/code-connect/)
- [Make kits](https://help.figma.com/hc/en-us/articles/39241689698839-Get-started-with-Make-kits)
