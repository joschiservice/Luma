# Shared frontend components

`@luma/ui` holds the interface building blocks: primitives in `components/primitives`, and issue and workspace compositions in `components/issues` and `components/workspace` with their stories and fixtures. Shared components own padding, borders, surfaces, text hierarchy and semantic colors; features own positioning, grids and domain presentation. Primitives never import compositions. Brand direction and the token process are in the [design workflow](design-workflow.md).

## Choosing a component

| Need                                      | Use                             | Rule                                                                            |
| ----------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| Top-level page title                      | `PageTitle`                     | The page's `h1`, visually hidden; actions move into the workspace bar           |
| Page about one record                     | `RecordHeader`                  | Names the record in the breadcrumb; shows its status and key facts              |
| Subject title, description and actions    | `PageHeader`                    | The visible `h1` of a page outside a section, such as an app's settings         |
| Where a piece of work stands              | `StateDot`, `StatePill`         | Always with a text label                                                        |
| Reloading a record or view                | `RefreshButton`                 | Icon-only, named by its tooltip; a labelled Retry when recovering from an error |
| Naming an icon-only control               | `Tooltip`                       | The trigger keeps its own accessible name; tooltips don't open on touch         |
| Domain identity in navigation and records | `DomainIcon`                    | External systems stay neutral                                                   |
| Bordered content and nested surfaces      | `Card` and its parts            | Group content that needs a boundary; prefer rows, toolbars and inspectors       |
| Notices and warnings                      | `Alert`                         | Choose the live-region role deliberately (below)                                |
| Short labels                              | `Badge`                         | Always text                                                                     |
| Empty collections                         | `Empty`                         | Describe this view, not the whole business                                      |
| Supporting detail                         | `Disclosure`                    | Evidence, audit events, metadata and technical details                          |
| Record lists and fact tables              | `DataTable`, `DataTableRowLink` | See [tables](#tables)                                                           |
| Counts over time or by category           | `BarChart`, `ChartLegend`       | Pair with a table of the same values                                            |

Interaction primitives (`Button`, `Field`, `Select`, `SearchableSelect`, `Dialog`, `DropdownMenu`, `Tabs`, `Pagination`, `SectionNavigation` and others) cover forms and navigation. Give link-styled buttons `buttonVariants()` on the link itself so link semantics survive. Coarse pointers get 44px targets automatically; don't shrink them. `Pagination` omits the total when a source does not report one, so never invent a count.

Choose people with `PersonPicker`. It searches names and emails, ignoring case and accents, and draws only the first 50 matches, so a workspace's full member list loads in one read and pages are a display concern. Revisit that with server-side search if workspaces grow to thousands of members, because name lookups such as decision owners also read the full list.

Map case states through `issueStatus` and `issueKind` in `components/issues/case-presentation` instead of per feature. Verified means the intended outcome was observed; an accepted request is still running. Keep source freshness separate from connection credentials and permissions.

## Composition rules

- Use `Card` `variant="subtle"` for nested supporting surfaces and `variant="plain"` when the container already supplies one. Keep heading levels correct with `CardTitle as="h3"` or `as="h4"`. Cards have no click behavior.
- Give an `Alert` `role="status"` or `role="alert"` only when its arrival should be announced; static guidance needs no live region. Descriptions accept block content and controls, so never nest an Alert inside a paragraph.
- `Disclosure` keeps native details/summary keyboard and open-state behavior; its first child is the summary. Menus and navigation drawers use their own components.
- Cards trim first and last child margins, and `CardContent` trims its children's outer margins. Add a content wrapper rather than edge resets in a page stylesheet.

## Tables

Every `DataTable` needs a `caption`; it is visually hidden and names the table for assistive technology. The first column labels each row unless `rowHeader` names another. Mark quantities, amounts and counts `numeric` for right alignment and tabular figures, and secondary columns `hideOnNarrow`. The caller owns sort state through `sort` and `onSortChange`. One `DataTableRowLink` per row makes the whole row open the record; pass a router link through `render`. Inside cards use `density="compact"` and `variant="plain"`. Wide tables scroll horizontally as a focusable region.

## Charts

`BarChart` stacks bars from one baseline: vertical for calendar buckets, horizontal for named categories. Assign series the `chart-1` to `chart-5` slots in order; use state colors only when the color means good or bad, and `muted` for unknown values. Set `unknown` on a category so it is hatched and never reads as zero, and `note` to mark an incomplete period. The chart is one tab stop with arrow-key navigation, and every bar has a spoken summary. Add `ChartLegend` for two or more series and offer a `DataTable` of the same values. The palette is validated for color-vision deficiencies on the card surface in both themes; validate again when changing `--chart-*` tokens.

## Pages and navigation

Top-level workspace pages are registered once in `workspaceDestinations` in the web identity feature. That list drives the sidebar, the command menu, the `G` keyboard shortcuts and the no-access explanation for its `permission`, so a page missing from it is unreachable by keyboard and search. Top-level pages are named once, by the breadcrumb; page-level explanations belong in contextual help or empty states, and page actions go into the bar through `WorkspacePageActionsSlot`. Pages about one record use `RecordHeader`: the breadcrumb reads “Section › Record” and is the only visible name, the `h1` stays for assistive technology, record actions go into the bar and the page opens with status flags and key facts. The section crumb returns to the list with its filters; when the reader arrived from another record, a back arrow before it returns there. Don't add a back link or a second title in the page. Page controls go into the top bar through `WorkspaceHeaderSlot`. Working views such as the issue inbox use `page-full`; reading pages use a comfortable maximum width.

Home and sidebar pins are per-member layouts; see [workspace settings](workspace-settings.md#personal-layouts). Home's attention module and the sidebar count read the [Needs you queue](needs-you.md).

## Collection pages

List pages keep one order: `PageTitle`, `CollectionToolbar`, the coverage line, notices, the table and pagination. The toolbar puts views and Refresh first, then search, one pill per filter, display actions and a single **Sort** menu. Every offered filter stays visible: unset filters are dashed pills that open their values in one click, applied filters are chips. On small screens unset pills collapse into one **Filters** button. Pages describe filters as data (`choice`, `date-range` or link-set `applied` filters) and own their URL state; the toolbar owns presentation, focus and the search draft.

The toolbar and list sit directly on the page, which the shell already insets; don't wrap them in a raised panel. Tables use the framed `DataTable`, and row lists that aren't tables use the same thin border and row dividers, as in the Workflows library. Summaries above a list, such as Procurement's commitments, form one bordered band rather than separate raised cards.

Use `CollectionFilterPanel` only for a narrow feed with five or more filters that people combine to investigate, as in Activity. Tables and split views keep the pills, because a docked panel costs them columns. Use `CollectionViews` for button views; link-based views can keep `Tabs`.

`SyncCoverage` condenses what each source has imported into one line. It leads with sources that need attention and says the list is incomplete while any import runs.

## Issue views

`IssueSplitView` keeps both pane trees mounted across layout changes so local interaction state survives resizing; don't conditionally render a pane. `IssuePageLayout` and `IssuePanelLayout` share section content and navigation. Contextual actions expand their target section before moving focus. `IssueListToolbar` adapts issue filters to `CollectionToolbar`; its caller owns URL state and fetching.

## State and data

| State                                         | Owner                           |
| --------------------------------------------- | ------------------------------- |
| Draft values, touched fields and validation   | TanStack Form                   |
| Server data, requests and mutation results    | TanStack Query                  |
| Shareable filters, sorting and view selection | TanStack Router search params   |
| Ephemeral UI state                            | React `useState` / `useReducer` |

- There is no global store or custom form framework. Do not mirror search params into another store: define `validateSearch` on the route, read `Route.useSearch()` and update with `navigate({ search })`.
- Use Zod schemas directly as Standard Schema validators. Form validation does not apply schema transforms, so parse again on submit to get normalized output. Validate unknown responses at the I/O boundary; the server validates requests independently.
- The router creates one QueryClient per router and request for SSR hydration. Never make a server QueryClient a module singleton. Keep query keys, mutations and invalidation beside their feature.
- Match domain discriminated unions with `ts-pattern` and `.exhaustive()`.
- Stories receive state through props and deterministic fixtures. Keep data fetching, auth, mutations and business decisions in the app; add a local decorator only when a component needs a provider, such as an in-memory router.

## Styling rules

- Read semantic tokens only. Theme tokens and primitive styling stay in `packages/ui/src/styles`; feature stylesheets, imported by the feature's page component, lay out shared components without restyling them.
- Use component variants for appearance and `className` for layout. Spacing comes from the shared density variables such as `--card-padding` and `--content-gap`.
- Keep text at 12px or larger and check contrast on tinted surfaces.

Tooling enforces part of this statically:

- `pnpm lint` rejects literal colors in JSX styles and appearance overrides on imported shared primitives, including aliased imports.
- `pnpm lint:ui` parses CSS in `apps/web/src` and workspace apps. It rejects literal hex and color-function values (mask colors excepted) and appearance declarations (color, background, border, shadow, font, line height, letter spacing, padding, fill, stroke) on card, badge, alert and button selectors.
- Existing violations are listed exactly in `tooling/style/ui-baseline.json`. New violations fail, and fixing one requires removing its baseline entry.

The checks cover static syntax only. They do not resolve dynamic class names or replace visual and accessibility review in both themes and at narrow widths.
