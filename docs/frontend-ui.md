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
| Records as rows with chosen properties    | `CollectionList`                | See [list layout](#list-layout-and-preview)                                     |
| The open record beside a table or list    | `CollectionPreview`             | See [list layout](#list-layout-and-preview)                                     |
| Grouped records with collapsible sections | `CollectionGroups`              | See [groups and board](#groups-and-board)                                       |
| Grouped records as columns of cards       | `CollectionBoard`               | See [groups and board](#groups-and-board)                                       |
| Counts over time or by category           | `BarChart`, `ChartLegend`       | Pair with a table of the same values                                            |
| Source text or cells beside cited facts   | `SourceText`, `SourceSheet`     | Facts list stays the keyboard path; highlights are click shortcuts              |

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

`DataTable` never sorts, filters or pages rows; it renders what the server returned. Pages opt into configurable columns with `columnState` and `onColumnStateChange`: header menus sort, filter, move, pin and hide, and the resize handle works by drag or arrow keys. The row header column and `required` columns can't be hidden, and other columns never move in front of the pinned one. The header sticks only while the table scrolls inside its own frame, so give the table a maximum height when it should. `selection` adds labelled checkboxes with shift-click ranges and announces the count; rows keep table semantics, so selection is carried by the checkboxes rather than `aria-selected`.

## Charts

`BarChart` stacks bars from one baseline: vertical for calendar buckets, horizontal for named categories. Assign series the `chart-1` to `chart-5` slots in order; use state colors only when the color means good or bad, and `muted` for unknown values. Set `unknown` on a category so it is hatched and never reads as zero, and `note` to mark an incomplete period. The chart is one tab stop with arrow-key navigation, and every bar has a spoken summary. Add `ChartLegend` for two or more series and offer a `DataTable` of the same values. The palette is validated for color-vision deficiencies on the card surface in both themes; validate again when changing `--chart-*` tokens.

## Web app layers

`apps/web/src` has four layers, and a module imports only its own layer or lower ones:

| Layer      | Holds                                                                                  |
| ---------- | -------------------------------------------------------------------------------------- |
| `shell`    | Workspace layout, navigation, search, Home and routes; composes features               |
| `features` | One folder per product area                                                            |
| `shared`   | Building blocks several features render, such as order presentation                    |
| `kit`      | Session, permissions, common states, workspace-wide data and live change subscriptions |

Features may use each other, but never in a cycle. When two features would need each other,
move the shared part down to `shared` or `kit`, or let the shell supply it: record pages show
linked inbox threads through `kit/record-messages`, which the shell fills with the inbox's view.
Stories and tests may use any layer. `pnpm test:architecture` checks the direction and cycles.
Features have no barrel `index.ts`: features import their own CSS, so a barrel would pull every
module and style of a feature into each route that uses one export.

## Pages and navigation

Top-level workspace pages are registered once in `workspaceDestinations` in the web shell. That list drives the sidebar, the command menu, the `G` keyboard shortcuts and the no-access explanation for its `permission`, so a page missing from it is unreachable by keyboard and search. Top-level pages are named once, by the breadcrumb; page-level explanations belong in contextual help or empty states, and page actions go into the bar through `WorkspacePageActionsSlot`. Pages about one record use `RecordHeader`: the breadcrumb reads “Section › Record” and is the only visible name, the `h1` stays for assistive technology, record actions go into the bar and the page opens with status flags and key facts. The section crumb returns to the list with its filters; when the reader arrived from another record, a back arrow before it returns there. Don't add a back link or a second title in the page. Page controls go into the top bar through `WorkspaceHeaderSlot`. Working views such as the issue inbox use `page-full`; reading pages use a comfortable maximum width.

Home and sidebar pins are per-member layouts; see [workspace settings](workspace-settings.md#personal-layouts). Home's attention module and the sidebar count read the [Needs you queue](needs-you.md).

## Collection pages

List pages keep one order: `PageTitle`, `CollectionToolbar`, the coverage line, notices, the table and pagination. The toolbar puts views and Refresh first, then search, one pill per filter, display actions and a single **Sort** menu. Every offered filter stays visible: unset filters are dashed pills that open their values in one click, applied filters are chips. On small screens unset pills collapse into one **Filters** button. Pages describe filters as data (`choice`, `multi-choice`, `date-range` or link-set `applied` filters) and own their URL state; the toolbar owns presentation, focus and the search draft.

Advanced conditions go through the toolbar's `conditions`: they follow the quick filters as chips, and **+ Filter** stays visible on every screen size. Conditions use the list API's `where` shape, so pass it through unchanged and show the API's per-condition problems through `issues` instead of dropping rejected conditions. `CollectionDisplay` goes into `display`, before Sort; it offers a layout only when a page has more than one, and board needs a grouping.

List pages bind keys with `useListKeyboard`. Its shortcuts never fire while typing, with a modifier key or while a dialog or menu is open, and keys a focused control already uses keep their meaning. Pass `keys` so focus stays on the same record when a refresh or poll reorders rows. Pass `ShortcutHelp` only the commands the page handles.

The toolbar and list sit directly on the page, which the shell already insets; don't wrap them in a raised panel. Tables use the framed `DataTable`, and row lists that aren't tables use the same thin border and row dividers, as in the Workflows library. Summaries above a list, such as Procurement's commitments, form one bordered band rather than separate raised cards.

Use `CollectionFilterPanel` only for a narrow feed with five or more filters that people combine to investigate, as in Activity. Tables and split views keep the pills, because a docked panel costs them columns. Use `CollectionViews` for button views; link-based views can keep `Tabs`.

### List layout and preview

`CollectionList` is the list layout: one list item per record with one link, a title, an optional second line and the properties chosen in Display, in comfortable or compact density. Keep it a real list with links, never an ARIA grid. Properties are columns that line up across rows through subgrid and move under the title in narrow containers; a page may render short properties, such as owner, in the second line instead. State that tells the reader something needs attention goes in `status`, which no Display setting hides. The catalog's title field is never a property, and `useCollectionControls` edits `properties` instead of `columns` outside the table layout. Empty `properties` means the page's defaults, so hiding every property brings the defaults back.

The preview pane shows the open record beside a table or list. The open record is page URL state (`item`, `thread` or a route segment), while the view's `preview` flag only says whether the layout opens records there; pages offer it through `useCollectionControls({ preview: true })`. Wire `useListKeyboard`'s `preview`: Space toggles the focused record only while focus is in the list, so Space still scrolls the preview; J and K move the open record with focus; Escape closes it first and returns focus to its row. `CollectionPreview` keeps both panes mounted, puts the preview in a resizable pane on wide screens and in a full-screen sheet over an inert list on narrow ones, moves focus into the sheet and back to the focused row when it closes. Opening by key leaves focus in the list. Issues, Needs you and the inbox keep `IssueSplitView`: their detail pane is the preview, so they don't offer the flag.

### Groups and board

Grouped tables and lists render the list API's `groups` in its order through `CollectionGroups`: each section's header button collapses it, names the group with its count, marks `complete: false` as incomplete and announces collapsing. Collapsed groups are the member's display setting (`collapsedGroups`), never view state, and pages scope them to the grouping so `true` of one field doesn't collapse another. Hide groups with no records unless the grouping says `showEmpty`; only choice and yes/no fields can name an empty group. "Show more" reads the group's next page with `groupKey` and the group's cursor through the kit's `useGroupPages`, whose pages reset when the request changes. Grouped reads take no page cursor, so the page shows no pagination.

`CollectionBoard` shows the same groups as columns of cards. Cards are list rows, so J and K run down each column in turn, and the board owns the arrow keys inside and between columns. A board is read-only unless the page passes `onMove`, which it may only do when Luma owns the grouping field and moves go through the governed edit path; then each card offers "Move to…", also opened with M. Provider-owned or derived fields never get a move affordance.

### Configurable list pages

A configurable list page provides, in this order:

- A route whose `validateSearch` extends the kit's `collectionSearchShape` with the page's context keys. `beforeLoad` rewrites filters of older links into `where` with `replace`, then calls `rememberedSearch` only when the URL names nothing: no view keys, search, page or context. A link such as `?q=SKU-1` or `?view=overdue` always wins over remembered state.
- When the catalog's `search` is `private`, because search can match personal data, `usePrivateSearch` keeps the text in page state, adopts a link's `q` and removes it with a replace that names the current view. Key paging trails without the text.
- `useCollectionView(catalog)` and `useCollectionControls` with the page's presentation, run-time options (connections, locations, currencies seen in rows) and `can`, so permission-gated fields show as unavailable instead of disappearing.
- A request built from the effective view state: segment, `where` only when it has conditions, sort, grouping, search and cursor, with the workspace time zone for calendar conditions. Use `keepPreviousData` so a filter change keeps the old rows until the new ones arrive, and `useCursorPaging` keyed by the view and request.
- `CollectionViewBar` in the toolbar's `views`, `DescribedFilter` in `actions`, `controls.display` and `controls.sort`, then `SyncCoverage`, `CollectionSummaryBand`, `CollectionNotices`, `CollectionBulkActions` for the selected rows, the results and `Pagination`.
- A route that hosts several lists keeps the list in a context key, as Procurement's `tab`, and passes it in the view bar's `path`, such as `procurement?tab=suppliers`; pins and saved-view links append `view` to it. Lists whose API can't filter or sort custom fields pass `customFilters: false`, so they show them as columns only.
- A view that asks for something the reader's list can't do needs repair, not a broader read: check conditions against the catalog and the reader's permissions before asking, map the engine's "Condition N" messages to their chips, and offer to remove what is unsupported.
- Built-in views that need their counts visible stay as `CollectionViews` tabs beside the view bar, with a `null` value while a saved view is open. A catalog without a default sort gets a Sort menu built by the page whose first option names the API's default order; it maps to a view without a sort and is offered only when the open view has none, because the URL can't express removing a saved sort. Columns that depend on run-time data, such as one per catalog source, go in `extraColumns` with letter-and-digit IDs, and `defaultColumns` shows them in views without their own columns.

`SyncCoverage` condenses what each source has imported into one line. It leads with sources that need attention and says the list is incomplete while any import runs.

## Issue views

`IssueSplitView` keeps both pane trees mounted across layout changes so local interaction state survives resizing; don't conditionally render a pane. `IssuePageLayout` and `IssuePanelLayout` share section content and navigation. Contextual actions expand their target section before moving focus. Issues, Needs you and the inbox are configurable lists: their toolbars are `CollectionToolbar` with the kit's controls, and an `owner` option of `useCollectionControls` adds the owner pill (Me, Unassigned or one member), which writes one owner condition that resolves `me` for each reader. Issues show grouped lists or a read-only board by state; Needs you and the inbox show grouped lists.

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
