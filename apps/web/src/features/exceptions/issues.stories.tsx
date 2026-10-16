import {
  caseClasses,
  caseStates,
  type CollectionGroup,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  caseFixture,
  inventoryCase,
} from '@luma/ui/components/issues/case-fixtures';
import { CaseInvestigation } from '@luma/ui/components/issues/case-investigation';
import { CaseTimeline } from '@luma/ui/components/issues/case-timeline';
import { IssueInspectorHeader } from '@luma/ui/components/issues/issue-inspector-header';
import { IssuePanelLayout } from '@luma/ui/components/issues/issue-panel-layout';
import { IssueSplitView } from '@luma/ui/components/issues/issue-split-view';
import { IssueSummary } from '@luma/ui/components/issues/issue-summary';
import { issueViews } from '@luma/ui/components/issues/issue-views';
import {
  resolutionProgress,
  resolutionReview,
} from '@luma/ui/components/issues/resolution-fixtures';
import { ResolutionReview } from '@luma/ui/components/issues/resolution-review';
import { Button } from '@luma/ui/components/primitives/button';
import {
  type CollectionFilter,
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Maximize2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';

import { StoryShell } from '../../shell/storybook-shell';
import { issuePresentation, issueProperties } from './issue-list';
import { IssueResults } from './results';

// Fixtures share one ID; the list keys rows by ID, so each gets its own.
const issues = [
  inventoryCase,
  caseFixture('sync_failure'),
  caseFixture('stuck_fulfillment'),
  caseFixture('workflow_failure'),
  caseFixture('pending'),
].map((issue, index) => ({
  ...issue,
  id: `11111111-1111-4111-8111-11111111111${index}`,
}));

/** Groups the fixtures by state, as the list API's `groups` would return them. */
const stateGroups: CollectionGroup[] = [
  ...new Set(issues.map((issue) => issue.state)),
].map((state) => {
  const rows = issues.filter((issue) => issue.state === state);

  return {
    key: state,
    count: rows.length,
    complete: true,
    itemIds: rows.map((issue) => issue.id),
    nextCursor: null,
    sums: [],
  };
});

function IssuesExample({
  selectedInitially = true,
  longEvidence = false,
  proposalReady = false,
  unconfirmed = false,
  layout = 'list',
}: {
  selectedInitially?: boolean;
  longEvidence?: boolean;
  proposalReady?: boolean;
  unconfirmed?: boolean;
  /** `grouped` groups the list by state; `board` shows the read-only board. */
  layout?: 'list' | 'grouped' | 'board';
}) {
  const [selected, setSelected] = useState<number | undefined>(
    selectedInitially ? 0 : undefined,
  );
  const review = proposalReady
    ? resolutionReview
    : {
        ...resolutionReview,
        proposal: null,
        permittedDecisions: ['escalate' as const],
      };
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'needs_you' | 'active' | 'history'>(
    'active',
  );
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  // The page's quick filters: each is one "is any of" condition on its catalog field.
  const quick = (key: string, values: readonly string[]): CollectionFilter => ({
    key,
    kind: 'multi-choice',
    label: issuePresentation[key]?.label() ?? key,
    value: filters[key],
    options: values.map((value) => ({
      value,
      label: issuePresentation[key]?.option?.(value) ?? value,
    })),
    onChange: (next) =>
      setFilters((current) => {
        const rest = { ...current };
        delete rest[key];

        return next ? { ...rest, [key]: next } : rest;
      }),
  });
  const selectedItem = selected === undefined ? undefined : issues[selected];
  const item =
    selectedItem && longEvidence && selectedItem.diagnosis
      ? {
          ...selectedItem,
          diagnosis: {
            ...selectedItem.diagnosis,
            provenance: {
              ...selectedItem.diagnosis.provenance,
              evidence: Array.from({ length: 48 }, (_, index) => ({
                ...selectedItem.diagnosis!.provenance.evidence[0]!,
                id: `evidence-${index}`,
              })),
            },
          },
        }
      : selectedItem;

  return (
    <>
      <StoryShell page="exceptions">
        <div
          className={`inbox ${selected !== undefined ? 'inbox-selected' : ''}`}
        >
          <header className="inbox-heading">
            <h1 className="sr-only">Issues</h1>
            <IssueSummary review={3} open={5} verified={12} />
          </header>
          <IssueSplitView
            selected={selected !== undefined}
            list={
              <div className="inbox-list">
                <CollectionToolbar
                  className="inbox-toolbar"
                  filters={[
                    quick('class', caseClasses),
                    quick('state', caseStates),
                    quick('severity', ['high', 'medium']),
                  ]}
                  onClear={() => setFilters({})}
                  onRefresh={() => {}}
                  views={
                    <CollectionViews
                      label={m.issues_views_label()}
                      value={view}
                      views={issueViews()}
                      onChange={(next) => {
                        setView(next);
                        setPage(1);
                      }}
                    />
                  }
                />
                <IssueResults
                  items={issues}
                  groups={layout === 'list' ? undefined : stateGroups}
                  layout={layout === 'board' ? 'board' : 'list'}
                  density="comfortable"
                  grouping={
                    layout === 'list'
                      ? null
                      : { field: 'state', showEmpty: false }
                  }
                  caption="Issues by status"
                  current={
                    selected === undefined ? undefined : issues[selected]?.id
                  }
                  link={(item) => (
                    <a
                      href={`#issue-${item.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        setSelected(
                          issues.findIndex((issue) => issue.id === item.id),
                        );
                      }}
                    />
                  )}
                  empty={null}
                  properties={issueProperties}
                  groupLabel={(key) =>
                    issuePresentation.state?.option?.(String(key)) ?? ''
                  }
                  collapsed={[]}
                  onCollapsedChange={() => {}}
                  more={() => undefined}
                />
                <Pagination
                  count={page === 1 ? 25 : 21}
                  totalCount={46}
                  page={page}
                  hasNext={page === 1}
                  onPrevious={page > 1 ? () => setPage(page - 1) : undefined}
                  onNext={() => setPage(page + 1)}
                  formatTotal={(count) =>
                    m.exceptions_pagination_total({ count })
                  }
                  label={m.exceptions_pagination_label()}
                />
              </div>
            }
            detail={
              selected !== undefined && (
                <section className="inbox-detail" aria-label="Selected issue">
                  <IssuePanelLayout
                    key={selected}
                    item={item}
                    actions={
                      <ResolutionReview
                        review={review}
                        progress={resolutionProgress}
                        onDecision={async () => {}}
                      />
                    }
                    header={
                      <IssueInspectorHeader
                        refresh={
                          <Button variant="ghost" aria-label="Refresh issue">
                            <RefreshCw size={14} />
                          </Button>
                        }
                        className="inbox-case-nav"
                        item={issues[selected]!}
                        openPage={
                          <a
                            href="#full-issue"
                            aria-label="Open full page"
                            className="issue-panel-open-page"
                          >
                            <Maximize2 size={16} />
                          </a>
                        }
                        onClose={() => setSelected(undefined)}
                      />
                    }
                  >
                    <CaseInvestigation
                      item={item!}
                      review={review}
                      unconfirmed={unconfirmed}
                      embedded
                      expanded
                      progress={
                        <CaseTimeline
                          expanded
                          progress={resolutionProgress}
                          review={review}
                          connection="live"
                          timeline={[]}
                          evidence={[]}
                        />
                      }
                    />
                  </IssuePanelLayout>
                </section>
              )
            }
          />
        </div>
      </StoryShell>
    </>
  );
}

const meta = {
  title: 'App/Issues workspace',
  component: IssuesExample,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: MINIMAL_VIEWPORTS },
  },
} satisfies Meta<typeof IssuesExample>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  globals: { theme: 'dark' },
};

export const InboxOnly: Story = {
  args: { selectedInitially: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: 'Previous' }),
    ).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(canvas.getByText('26–46 of 46 issues')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Previous' }));
    await expect(canvas.getByText('1–25 of 46 issues')).toBeVisible();
    await userEvent.click(
      canvas.getByText('Shopify shows 8 more available than JTL'),
    );
    await expect(
      canvas.getByRole('region', { name: 'Selected issue' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Close panel' }));
    await expect(
      canvas.queryByRole('region', { name: 'Selected issue' }),
    ).not.toBeInTheDocument();
  },
};

export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const LongEvidence: Story = {
  args: { longEvidence: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', {
        name: 'View supporting evidence',
      }),
    );
    await expect(
      canvas.getByRole('heading', { name: 'Supporting evidence' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Close panel' }),
    ).not.toBeInTheDocument();
    const header = canvas
      .getByRole('heading', { name: 'Supporting evidence' })
      .closest('header')!;
    await expect(within(header).getByText('48 evidence records')).toBeVisible();
    await expect(
      within(header).getByText('Shopify shows 8 more available than JTL.'),
    ).toBeVisible();
    await userEvent.click(
      within(header).getByRole('button', { name: 'Back to issue' }),
    );
    await expect(
      canvas.getByRole('button', { name: 'Close panel' }),
    ).toBeVisible();
  },
};

export const PanelNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = within(
      canvas.getByRole('region', { name: 'Selected issue' }),
    );
    await expect(
      panel.queryByRole('combobox', { name: 'Issue section' }),
    ).not.toBeInTheDocument();
    const findings = panel
      .getByRole('region', { name: 'Findings' })
      .querySelector('details')!;
    await expect(findings).toHaveAttribute('open');
    await userEvent.click(findings.querySelector('summary')!);
    await expect(findings).not.toHaveAttribute('open');
    const execution = panel
      .getByRole('region', { name: 'Change and outcome check' })
      .querySelector('details')!;
    await expect(execution).not.toHaveAttribute('open');
    await userEvent.click(execution.querySelector('summary')!);
    await expect(execution).toHaveAttribute('open');
    await expect(
      panel.queryByRole('list', { name: 'Issue progress' }),
    ).not.toBeInTheDocument();
    const resolution = panel
      .getByRole('region', { name: 'Proposed change' })
      .querySelector('details')!;
    await expect(resolution).not.toHaveAttribute('open');
    await userEvent.click(resolution.querySelector('summary')!);
    await userEvent.click(
      panel.getByRole('button', { name: 'View recommended next step' }),
    );
    await expect(panel.getByRole('region', { name: 'Overview' })).toHaveFocus();
  },
};

export const RemovableFilters: Story = {
  args: { selectedInitially: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add Severity filter' }),
    );
    await userEvent.click(await body.findByRole('button', { name: 'High' }));
    await userEvent.click(body.getByRole('button', { name: 'Done' }));
    await expect(
      canvas.getByRole('button', { name: 'Edit Severity filter: High' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Add Severity filter' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Edit Severity filter: High' }),
    );
    await userEvent.click(await body.findByRole('button', { name: 'Medium' }));
    await userEvent.click(body.getByRole('button', { name: 'Done' }));
    await userEvent.click(
      canvas.getByRole('button', {
        name: 'Remove Severity filter: High or Medium',
      }),
    );
    await waitFor(() =>
      expect(
        canvas.getByRole('button', { name: 'Add Severity filter' }),
      ).toHaveFocus(),
    );
    await expect(
      canvas.queryByRole('button', { name: 'Clear' }),
    ).not.toBeInTheDocument();
  },
};

export const ProposedChange: Story = {
  args: { proposalReady: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const overview = within(canvas.getByRole('region', { name: 'Overview' }));
    const resolution = canvas.getByRole('region', { name: 'Proposed change' });
    await expect(resolution.querySelector('details')).not.toHaveAttribute(
      'open',
    );
    await userEvent.click(
      overview.getByRole('button', { name: 'Review proposed change' }),
    );
    await expect(resolution.querySelector('details')).toHaveAttribute('open');
    await expect(
      within(resolution).getByRole('heading', {
        name: 'Review the proposed change',
      }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('region', { name: 'Proposed change' }),
    ).toHaveFocus();
  },
};

export const UnconfirmedProposal: Story = {
  args: { proposalReady: true, unconfirmed: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole('button', {
        name: 'Review proposed change',
      }),
    ).not.toBeInTheDocument();
  },
};

export const ResizableInspector: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const divider = await canvas.findByRole('separator', {
      name: 'Resize issue panel',
    });
    const detail = canvas.getByRole('region', { name: 'Selected issue' });
    const initialWidth = detail.getBoundingClientRect().width;
    divider.focus();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(detail.getBoundingClientRect().width).toBeGreaterThan(
      initialWidth,
    );
    const resizedWidth = detail.getBoundingClientRect().width;
    await userEvent.click(canvas.getByRole('button', { name: 'Close panel' }));
    await expect(divider).not.toBeVisible();
    await userEvent.click(
      canvas.getByText('Shopify shows 8 more available than JTL'),
    );
    await expect(divider).toBeVisible();
    await expect(
      canvas
        .getByRole('region', { name: 'Selected issue' })
        .getBoundingClientRect().width,
    ).toBeCloseTo(resizedWidth, 0);
  },
};

export const ViewNavigation: Story = {
  args: { selectedInitially: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const review = canvas.getByRole('tab', { name: 'Needs attention' });
    const open = canvas.getByRole('tab', { name: 'All open' });
    await expect(open).toHaveAttribute('aria-selected', 'true');
    open.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(review).toHaveFocus();
    await expect(open).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    await expect(review).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(canvas.getByRole('tab', { name: 'History' }));
    await expect(canvas.getByRole('tab', { name: 'History' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};

export const GroupedByStatus: Story = {
  args: { selectedInitially: false, layout: 'grouped' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const groups = canvas.getByRole('group', { name: 'Issues by status' });
    await expect(
      within(groups).getAllByRole('button', { expanded: true }).length,
    ).toBeGreaterThan(0);
  },
};

export const Board: Story = {
  args: { selectedInitially: false, layout: 'board' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/cards can’t be moved between columns/),
    ).toBeVisible();
    // The board is read-only: no card offers a move.
    await expect(
      canvas.queryByRole('button', { name: /Move to/ }),
    ).not.toBeInTheDocument();
  },
};

export const BoardDark: Story = {
  args: { selectedInitially: false, layout: 'board' },
  globals: { theme: 'dark' },
};
