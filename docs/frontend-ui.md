# Shared frontend components

The product frontend imports visual primitives from `@luma/ui/components/primitives/*`. Page CSS owns positioning, grids and feature-specific data presentation. Shared components own padding, borders, surfaces, text hierarchy and semantic colors.

Feature compositions live separately in `components/issues`, `components/overview` and `components/workspace`, with their stories and fixtures colocated. Primitives must not import feature compositions.

## Reusable patterns

| Pattern                              | Component                                                                         | Current callers                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Bordered content and nested surfaces | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | Overview metrics and sections, issue sections and collections, connections, playbooks, Shadow evaluation, authentication and workspace creation |
| Notices and warnings                 | `Alert`, `AlertTitle`, `AlertDescription`                                         | Issue notices, overview health, connection permissions, playbook blockers, offline notices, activity errors, resolution recovery                |
| Short state labels                   | `Badge`                                                                           | Issue severity and attention, execution outcome, connection status, playbook activation status, overview severity                               |
| Empty collections                    | `Empty`                                                                           | Connections, issues, playbooks and activity                                                                                                     |
| Expandable supporting content        | `Disclosure`                                                                      | Evidence, audit events, issue metadata, investigations, playbook details and Shadow results                                                     |

Existing shared `Button`, `Input`, `Select`, `Field`, `Dialog`, `Pagination` and `SectionNavigation` remain the interaction primitives. Domain components such as `ConnectionCard`, `IssueSection` and `CaseNotice` compose these primitives and retain domain behavior.

`IssuePageLayout` and `IssuePanelLayout` share section content and navigation behavior. The full page uses `IssueSectionSelect` on small screens to navigate after the Select menu releases focus. The inspector keeps Overview visible and uses native disclosures for supporting sections, with Findings initially open. Contextual actions expand their target section before moving focus. `IssueListToolbar` owns the reusable view/filter controls; its caller owns URL state and fetching.

The application shell, navigation, tables, timelines, comparison grids, form validation and branded landing layout have distinct responsibilities. They should not become generic cards merely because they contain borders or text. The simulator control frontend is a separate plain JavaScript developer tool; it cannot import React components directly.

## Composition

```tsx
<Card as="section" aria-labelledby="review-title">
  <CardHeader>
    <div>
      <CardTitle id="review-title">Review</CardTitle>
      <CardDescription>Inspect the proposed correction.</CardDescription>
    </div>
    <Badge tone="warning">Needs approval</Badge>
  </CardHeader>
  <CardContent>{content}</CardContent>
  <CardFooter>{actions}</CardFooter>
</Card>
```

Use `variant="subtle"` for nested supporting surfaces and `variant="plain"` when the surrounding container already supplies a surface. Keep document heading levels correct with `CardTitle as="h3"` or `as="h4"`. Cards do not add click behavior.

Use `Alert` for a notice, and explicitly choose `role="status"` or `role="alert"` when its arrival should be announced. Static guidance does not need a live region. Alert descriptions accept block content and controls. Do not nest an Alert inside a paragraph.

Badges always contain a text label. Success represents the named successful state; an executed action is not proof of a verified resolution. Keep source freshness separate from connection credentials and permissions.

`Disclosure` retains native details/summary keyboard and open-state behavior. Include a summary as its first child. Menus and navigation drawers continue to use their dedicated components.

## Density and maintenance

The UI stylesheet owns `--card-padding`, `--content-gap`, `--content-related-gap`, `--content-section-gap` and `--surface-detail`. Cards trim first and last child margins; `CardContent` trims its children's outer margins. Add a content wrapper instead of descendant-specific edge resets in a page stylesheet.

Use component variants for appearance and `className` for layout. Do not add page selectors that restyle shared card padding, Alert colors or Badge typography. Touch controls keep a 44px minimum target.

Storybook's **UI / Content surfaces** demonstrates the shared patterns and disclosure interaction. Feature stories cover the actual domain compositions in both themes and at narrow viewport widths.

`ResizablePanelGroup`, `ResizablePanel` and `ResizableHandle` wrap shadcn’s `react-resizable-panels` integration. `IssueSplitView` composes them for the inbox, with minimum list/detail widths and a single-pane layout on narrow screens. Both pane trees stay mounted across layout changes to preserve local interaction state.
