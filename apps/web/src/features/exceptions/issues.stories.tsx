import type { CaseQuery } from '@luma/api-contract';
import {
  caseFixture,
  inventoryCase,
} from '@luma/ui/components/issues/case-fixtures';
import {
  CaseInvestigation,
  CaseRow,
} from '@luma/ui/components/issues/case-investigation';
import { CaseTimeline } from '@luma/ui/components/issues/case-timeline';
import { IssueInspectorHeader } from '@luma/ui/components/issues/issue-inspector-header';
import { IssueListToolbar } from '@luma/ui/components/issues/issue-list-toolbar';
import { IssuePanelLayout } from '@luma/ui/components/issues/issue-panel-layout';
import { IssueSplitView } from '@luma/ui/components/issues/issue-split-view';
import { IssueSummary } from '@luma/ui/components/issues/issue-summary';
import { IssueViewTabs } from '@luma/ui/components/issues/issue-view-tabs';
import {
  resolutionProgress,
  resolutionReview,
} from '@luma/ui/components/issues/resolution-fixtures';
import { ResolutionReview } from '@luma/ui/components/issues/resolution-review';
import { Button } from '@luma/ui/components/primitives/button';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { WorkspaceAccountMenu } from '@luma/ui/components/workspace/workspace-account-menu';
import { figmaScreen } from '@luma/ui/lib/figma';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Inbox,
  LayoutDashboard,
  Maximize2,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';

import appStyles from '../../styles.css?inline';
import { Brand } from '../identity/common';
import { WorkspaceLayout } from '../identity/workspace-layout';

const issues = [
  inventoryCase,
  caseFixture('sync_failure'),
  caseFixture('stuck_fulfillment'),
  caseFixture('workflow_failure'),
  caseFixture('pending'),
];

function IssuesExample({
  selectedInitially = true,
  longEvidence = false,
  proposalReady = false,
  unconfirmed = false,
}: {
  selectedInitially?: boolean;
  longEvidence?: boolean;
  proposalReady?: boolean;
  unconfirmed?: boolean;
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
    'needs_you',
  );
  const [filters, setFilters] = useState<
    Pick<CaseQuery, 'state' | 'class' | 'severity'>
  >({});
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
      <style>{appStyles}</style>
      <WorkspaceLayout
        brand={<Brand />}
        context={
          <>
            <Inbox size={16} aria-hidden="true" />
            <span>Issues</span>
          </>
        }
        navigation={() => (
          <nav aria-label="Workspace navigation">
            {[
              { name: 'Overview', Icon: LayoutDashboard },
              { name: 'Issues', Icon: Inbox },
              { name: 'Connections', Icon: Unplug },
            ].map(({ name, Icon }) => (
              <a
                key={name}
                href={`#${name}`}
                className={name === 'Issues' ? 'active' : undefined}
                aria-current={name === 'Issues' ? 'page' : undefined}
              >
                <Icon size={18} />
                {name}
              </a>
            ))}
          </nav>
        )}
        accountMenu={
          <WorkspaceAccountMenu
            name="Alex Morgan"
            workspace="Northstar Commerce"
            workspaceId="northstar"
            workspaces={[
              {
                id: 'northstar',
                name: 'Northstar Commerce',
                link: <a href="#workspace" />,
              },
            ]}
            createLink={<a href="#new" />}
          />
        }
      >
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
                <IssueListToolbar
                  filters={filters}
                  onFiltersChange={(patch) =>
                    setFilters((current) => ({ ...current, ...patch }))
                  }
                  onRefresh={() => {}}
                  views={
                    <IssueViewTabs
                      value={view}
                      renderLink={(next) => (
                        <a
                          href={`#${next}`}
                          onClick={(event) => {
                            event.preventDefault();
                            setView(next);
                            setPage(1);
                          }}
                        />
                      )}
                    />
                  }
                />
                <ul className="inbox-rows">
                  {issues.map((item, index) => (
                    <li key={index}>
                      <a
                        href={`#issue-${index}`}
                        aria-current={selected === index ? 'page' : undefined}
                        onClick={(event) => {
                          event.preventDefault();
                          setSelected(index);
                        }}
                      >
                        <CaseRow item={item} />
                      </a>
                    </li>
                  ))}
                </ul>
                <Pagination
                  count={page === 1 ? 25 : 21}
                  totalCount={46}
                  page={page}
                  hasNext={page === 1}
                  onPrevious={page > 1 ? () => setPage(page - 1) : undefined}
                  onNext={() => setPage(page + 1)}
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
      </WorkspaceLayout>
    </>
  );
}

const meta = {
  title: 'App/Issues workspace',
  component: IssuesExample,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: MINIMAL_VIEWPORTS },
    design: figmaScreen('issuesLight'),
  },
} satisfies Meta<typeof IssuesExample>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  globals: { theme: 'dark' },
  parameters: { design: figmaScreen('issuesDark') },
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
    await expect(within(header).getByText('48 records')).toBeVisible();
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
      .getByRole('region', { name: 'Execution' })
      .querySelector('details')!;
    await expect(execution).not.toHaveAttribute('open');
    await userEvent.click(execution.querySelector('summary')!);
    await expect(execution).toHaveAttribute('open');
    await expect(
      panel.queryByRole('list', { name: 'Case lifecycle' }),
    ).not.toBeInTheDocument();
    const resolution = panel
      .getByRole('region', { name: 'Resolution' })
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
    await userEvent.click(canvas.getByRole('button', { name: 'Add filter' }));
    await userEvent.hover(
      await body.findByRole('menuitem', { name: 'Severity' }),
    );
    await userEvent.click(
      await body.findByRole('menuitemradio', { name: 'High' }),
    );
    await expect(
      canvas.getByRole('button', { name: 'Edit Severity filter: High' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Add filter' }));
    await expect(
      body.queryByRole('menuitem', { name: 'Severity' }),
    ).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(
      canvas.getByRole('button', { name: 'Edit Severity filter: High' }),
    );
    await userEvent.click(
      await body.findByRole('menuitemradio', { name: 'Medium' }),
    );
    await userEvent.click(
      canvas.getByRole('button', { name: 'Remove Severity filter: Medium' }),
    );
    await expect(
      canvas.getByRole('button', { name: 'Add filter' }),
    ).toHaveFocus();
    await expect(
      canvas.queryByRole('button', { name: 'Clear filters' }),
    ).not.toBeInTheDocument();
  },
};

export const ProposedChange: Story = {
  args: { proposalReady: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const overview = within(canvas.getByRole('region', { name: 'Overview' }));
    const resolution = canvas.getByRole('region', { name: 'Resolution' });
    await expect(resolution.querySelector('details')).not.toHaveAttribute(
      'open',
    );
    await userEvent.click(
      overview.getByRole('button', { name: 'Review proposed change' }),
    );
    await expect(resolution.querySelector('details')).toHaveAttribute('open');
    await expect(
      within(resolution).getByRole('heading', {
        name: 'Review the proposed correction',
      }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('region', { name: 'Resolution' }),
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
    const review = canvas.getByRole('tab', { name: 'Needs review' });
    const open = canvas.getByRole('tab', { name: 'All open' });
    await expect(review).toHaveAttribute('aria-selected', 'true');
    review.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(open).toHaveFocus();
    await expect(review).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    await expect(open).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(canvas.getByRole('tab', { name: 'History' }));
    await expect(canvas.getByRole('tab', { name: 'History' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};
