# Shared frontend components

The product frontend imports visual primitives from `@luma/ui/components/primitives/*`. Page CSS owns positioning, grids and feature-specific data presentation. Shared components own padding, borders, surfaces, text hierarchy and semantic colors. See the [design workflow](design-workflow.md) for tokens and the brand direction.

Feature compositions live separately in `components/issues` and `components/workspace`, with their stories and fixtures colocated. Primitives must not import feature compositions.

## Reusable patterns

| Pattern                              | Component                                                                         | Use it for                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Page title, description and actions  | `PageHeader` (`components/workspace/page-header`)                                 | The single `h1` of a workspace page, with an optional domain icon                            |
| Operational state                    | `StateDot`, `StatePill`                                                           | Where a piece of work stands: running, approval, attention, error, verified, waiting, idle   |
| Domain landmark                      | `DomainIcon`                                                                      | Navigation and record identity for orders, inventory, procurement, workflows and other areas |
| Brand marks                          | `LumaMark`, `LumaLockup`, `AurenMark`                                             | Entry pages, the favicon and attribution                                                     |
| Keyboard hints                       | `Kbd`                                                                             | Shortcut hints next to commands that stay accessible elsewhere                               |
| Bordered content and nested surfaces | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | Home modules, record sections, app tiles and dialogs                                         |
| Notices and warnings                 | `Alert`, `AlertTitle`, `AlertDescription`                                         | Issue notices, setup guidance, permissions, offline and recovery messages                    |
| Short labels                         | `Badge`                                                                           | Severity, activation status, personal settings and counts                                    |
| Empty collections                    | `Empty`                                                                           | Lists with nothing to show; describe this view, not the whole business                       |
| Expandable supporting content        | `Disclosure`                                                                      | Evidence, audit events, metadata and technical details                                       |

`Button`, `Input`, `Textarea`, `Select`, `SearchableSelect`, `Field`, `Switch`, `Dialog`, `DropdownMenu`, `Tabs`, `Pagination` and `SectionNavigation` remain the interaction primitives. `Button` has default (Cobalt), outline, ghost and destructive variants in default, `sm`, `lg` and `icon` sizes; coarse pointers receive 44px targets. Link-styled buttons use `buttonVariants()` on the link itself so link semantics are preserved.

Choose states from `issueStatus` and `issueKind` in `components/issues/case-presentation` rather than mapping case states in each feature. Verified means the intended outcome was observed; an accepted request is still running.

## Workspace shell

`WorkspaceLayout` renders a persistent sidebar on the canvas and an inset page surface. The sidebar holds the workspace switcher, search, core areas (Home, Issues, Records, Activity, Insights), pinned pages, operations domains (Orders, Workflows, Procurement), installed apps, and Apps and Settings. It collapses to an icon rail with `[` and moves into a drawer below 900px. The top bar shows breadcrumbs, page controls portaled through `WorkspaceHeaderSlot`, the pin control and contextual help.

Search opens a command menu with ⌘K or Ctrl K. It lists pages and actions such as switching appearance. `G` followed by a letter jumps to a destination, for example G then I for Issues.

Pages set their own width. Working views such as the issue inbox use `page-full` and fill the surface; reading pages use a comfortable maximum width.

## Home and personal layouts

Home answers what needs the reader's attention and what Luma is handling. It is built from modules: attention, handling, connected systems and activity by default, with resolution outcomes, operational pulse and order flow available. Each member arranges their own Home per workspace and can pin any page, including its filters, to the sidebar. Layouts are stored through `GET` and `PUT /v1/organizations/:organizationId/settings/layout` with revision checks; see `features/layout/data.ts` and **Settings → Home & sidebar**. Theme and sidebar width are device preferences stored locally.

## Composition

```tsx
<Card as="section" aria-labelledby="review-title">
  <CardHeader>
    <div>
      <CardTitle id="review-title">Review</CardTitle>
      <CardDescription>Inspect the proposed correction.</CardDescription>
    </div>
    <StatePill state="approval">Needs approval</StatePill>
  </CardHeader>
  <CardContent>{content}</CardContent>
  <CardFooter>{actions}</CardFooter>
</Card>
```

Use `variant="subtle"` for nested supporting surfaces and `variant="plain"` when the surrounding container already supplies a surface. Keep document heading levels correct with `CardTitle as="h3"` or `as="h4"`. Cards do not add click behavior.

Use `Alert` for a notice, and explicitly choose `role="status"` or `role="alert"` when its arrival should be announced. Static guidance does not need a live region. Alert descriptions accept block content and controls. Do not nest an Alert inside a paragraph.

Badges and state pills always contain a text label. Keep source freshness separate from connection credentials and permissions.

`Disclosure` retains native details/summary keyboard and open-state behavior. Include a summary as its first child. Menus and navigation drawers continue to use their dedicated components.

## Issues

`IssueSplitView` composes the resizable panels for the inbox, with minimum list and detail widths and a single-pane layout on narrow screens. Both pane trees stay mounted across layout changes to preserve local interaction state. The inbox toolbar spans the page above the split view; filters wrap on small screens.

`IssuePageLayout` and `IssuePanelLayout` share section content and navigation behavior. The full page moves its identity and actions into the top bar and uses `IssueSectionSelect` on small screens. The inspector keeps Overview visible and uses native disclosures for supporting sections, with Findings initially open. Contextual actions expand their target section before moving focus. `IssueViewTabs` composes the shadcn `Tabs` primitives with URL-backed links. `IssueListToolbar` owns the view toolbar and editable filter chips; its caller owns URL state and fetching.

## Density and maintenance

The UI stylesheet owns `--card-padding`, `--content-gap`, `--content-related-gap`, `--content-section-gap` and `--surface-detail`. Cards trim first and last child margins; `CardContent` trims its children's outer margins. Add a content wrapper instead of descendant-specific edge resets in a page stylesheet.

Use component variants for appearance and `className` for layout. Do not add page selectors that restyle shared card padding, Alert colors or Badge typography. Keep text at 12px or larger and check contrast on tinted surfaces.

Storybook's **Foundations/Theme** documents tokens, states and landmarks. Feature stories cover the actual domain compositions in both themes and at narrow viewport widths.
