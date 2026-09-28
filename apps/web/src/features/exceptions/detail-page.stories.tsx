import type { CaseDetail } from '@luma/api-contract';
import {
  caseFixture,
  inventoryCase,
} from '@luma/ui/components/issues/case-fixtures';
import {
  CaseInvestigation,
  CaseNotice,
} from '@luma/ui/components/issues/case-investigation';
import { CaseTimeline } from '@luma/ui/components/issues/case-timeline';
import { IssueDetailViews } from '@luma/ui/components/issues/issue-collection';
import { IssueInspectorHeader } from '@luma/ui/components/issues/issue-inspector-header';
import { IssuePageLayout } from '@luma/ui/components/issues/issue-page-layout';
import {
  resolutionProgress,
  resolutionReview,
} from '@luma/ui/components/issues/resolution-fixtures';
import { ResolutionReview } from '@luma/ui/components/issues/resolution-review';
import { Button } from '@luma/ui/components/primitives/button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArrowLeft, Maximize2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { StoryShell } from '../identity/storybook-shell';

const evidence = Array.from({ length: 48 }, (_, index) => ({
  ...inventoryCase.diagnosis!.provenance.evidence[0]!,
  id: `evidence-${index}`,
  completeness: 'complete' as const,
}));
const issue: CaseDetail = {
  ...inventoryCase,
  state: 'awaiting_approval',
  diagnosis: {
    ...inventoryCase.diagnosis!,
    provenance: { ...inventoryCase.diagnosis!.provenance, evidence },
  },
};
const timeline = Array.from({ length: 32 }, (_, index) => ({
  id: `event-${index}`,
  type: 'execution.prepared',
  actorId: 'inventory-worker',
  proposalId: null,
  outcome: null,
  evidenceRefs: ['evidence-0'],
  occurredAt: new Date(
    Date.parse(inventoryCase.lastActivityAt) - index * 60_000,
  ).toISOString(),
}));

function IssuePagePreview({
  item = issue,
  initiallyFull = true,
  unavailable = false,
  noProposal = false,
}: {
  item?: CaseDetail;
  initiallyFull?: boolean;
  unavailable?: boolean;
  noProposal?: boolean;
}) {
  const [full, setFull] = useState(initiallyFull);
  const content = (
    <CaseInvestigation
      item={item}
      embedded
      expanded={full}
      progress={
        <CaseTimeline
          expanded={full}
          progress={resolutionProgress}
          review={resolutionReview}
          timeline={timeline}
          evidence={evidence}
          connection="live"
        />
      }
    />
  );

  return (
    <>
      <StoryShell page="Issues">
        {full ? (
          <IssuePageLayout
            item={unavailable ? undefined : item}
            back={
              <Button
                variant="ghost"
                aria-label="Back to issues"
                onClick={() => setFull(false)}
              >
                <ArrowLeft size={16} /> Issues
              </Button>
            }
            refresh={
              <Button variant="outline" aria-label="Refresh">
                <RefreshCw size={14} />
                <span className="issue-page-desktop-label">Refresh</span>
              </Button>
            }
            canReview={!unavailable}
            actions={
              unavailable ? null : (
                <section tabIndex={-1} aria-label="Resolution review">
                  <ResolutionReview
                    review={
                      noProposal
                        ? {
                            ...resolutionReview,
                            proposal: null,
                            permittedDecisions: ['escalate'],
                            refreshable: true,
                          }
                        : resolutionReview
                    }
                    progress={resolutionProgress}
                    onDecision={fn()}
                    connectionLabel="JTL · North warehouse"
                  />
                </section>
              )
            }
          >
            {unavailable ? (
              <CaseNotice error title="Case unavailable">
                This case is missing or you no longer have access.
              </CaseNotice>
            ) : (
              content
            )}
          </IssuePageLayout>
        ) : (
          <div className="inbox inbox-selected">
            <div className="inbox-workspace">
              <div className="inbox-list">
                <h1>Issues</h1>
                <p>All open · High severity</p>
                <p>{item.summary}</p>
              </div>
              <section className="inbox-detail" aria-label="Selected issue">
                <IssueDetailViews
                  issueTitle={item.summary}
                  headerClassName="inbox-case-nav"
                  header={
                    <IssueInspectorHeader
                      item={item}
                      className="inbox-case-nav"
                      onClose={fn()}
                      openPage={
                        <a
                          href="#full-page"
                          className="issue-panel-open-page"
                          aria-label="Open full page"
                          onClick={(event) => {
                            event.preventDefault();
                            setFull(true);
                          }}
                        >
                          <Maximize2 size={16} />
                        </a>
                      }
                    />
                  }
                >
                  {content}
                </IssueDetailViews>
              </section>
            </div>
          </div>
        )}
      </StoryShell>
    </>
  );
}

const meta = {
  title: 'App/Issue full page',
  component: IssuePagePreview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof IssuePagePreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', {
        level: 1,
        name: 'Shopify shows 8 more available than JTL',
      }),
    ).toBeVisible();
    await expect(canvas.getByText('Issue ID')).toBeVisible();
    for (const title of [
      'Overview',
      'Findings',
      'Execution',
      'Audit history',
      'Evidence',
      'Resolution',
      'Issue details',
    ]) {
      const card = canvas.getByRole('region', { name: title });
      await expect(card).toHaveClass('issue-section-card');
      await expect(
        within(card).getByRole('heading', { level: 2, name: title }),
      ).toBeVisible();
    }
    await expect(
      canvas.getByRole('heading', { level: 1 }).closest('.desk-header'),
    ).not.toBeNull();
    await expect(
      canvas
        .getByRole('region', { name: 'Issue details' })
        .closest('.issue-page-main'),
    ).not.toBeNull();

    await userEvent.click(
      canvas.getByRole('button', { name: 'Audit history' }),
    );
    await expect(
      canvasElement.querySelector('[data-issue-section="history"]'),
    ).toHaveFocus();
    await expect(
      canvas.getByRole('button', { name: 'Audit history' }),
    ).toHaveAttribute('aria-current', 'location');
    await userEvent.click(
      canvas.getByRole('button', { name: 'View full history (32)' }),
    );
    await expect(
      canvas.getByRole('heading', { name: 'Audit history' }),
    ).toHaveFocus();
    await expect(
      canvas.queryByRole('navigation', { name: 'Issue sections' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Back to issue' }),
    );
    await userEvent.click(
      canvas.getByRole('button', { name: 'Review resolution' }),
    );
    await expect(
      canvas.getByRole('region', { name: 'Resolution' }),
    ).toHaveFocus();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Back to issues' }),
    );
    await expect(
      canvas.getByRole('region', { name: 'Selected issue' }),
    ).toBeVisible();
    await expect(canvas.getByText('All open · High severity')).toBeVisible();
  },
};

export const OpenFromPanel: Story = {
  args: { initiallyFull: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: 'Open full page' }));
    await expect(
      canvas.queryByRole('combobox', { name: 'On this page' }) ??
        canvas.getByRole('navigation', { name: 'Issue sections' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('region', { name: 'Selected issue' }),
    ).not.toBeInTheDocument();
  },
};

export const FailedInvestigation: Story = {
  args: { item: caseFixture('failed') },
};

export const Pending: Story = { args: { item: caseFixture('pending') } };

export const Unavailable: Story = { args: { unavailable: true } };

export const Dark: Story = { globals: { theme: 'dark' } };

export const SectionNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const scroll = canvasElement.querySelector('.desk-content')!;
    const evidence = canvasElement.querySelector<HTMLElement>(
      '[data-issue-section="evidence"]',
    )!;
    evidence.scrollIntoView({ block: 'start' });
    await waitFor(() =>
      expect(
        canvasElement.querySelector(
          '.issue-page-sections [aria-current="location"]',
        ),
      ).toHaveTextContent('Evidence'),
    );
    const picker = canvas.queryByRole('combobox', { name: 'On this page' });
    if (picker) {
      await expect(picker).toHaveTextContent('Evidence');
      await userEvent.click(picker);
      await userEvent.click(
        await within(document.body).findByRole('option', {
          name: 'Issue details',
        }),
      );
      await expect(picker).toHaveTextContent('Issue details');
    } else {
      await userEvent.click(
        canvas.getByRole('button', { name: 'Issue details' }),
      );
      await expect(
        canvas.getByRole('button', { name: 'Issue details' }),
      ).toHaveAttribute('aria-current', 'location');
    }
    await expect(scroll.scrollTop).toBeGreaterThan(0);
    scroll.scrollTop = 0;
    await waitFor(() =>
      expect(
        canvasElement.querySelector(
          '.issue-page-sections [aria-current="location"]',
        ),
      ).toHaveTextContent('Overview'),
    );
  },
};

export const LongTitle: Story = {
  args: {
    item: {
      ...issue,
      summary:
        'Inventory differs between Shopify and JTL for the linen shirt collection across several fulfillment locations and the shared stock pool.',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = canvas.getByRole('heading', { level: 1 });
    title.focus();
    await expect(
      canvasElement.querySelector('.issue-page-full-title'),
    ).toBeVisible();
    await expect(title.closest('.desk-header')).not.toBeNull();
    canvas.getByRole('button', { name: 'Refresh' }).focus();
    await expect(
      canvasElement.querySelector('.issue-page-full-title'),
    ).not.toBeVisible();
  },
};

export const OverviewActions: Story = {
  args: {
    item: {
      ...issue,
      summary:
        'Selling availability exceeds the configured authority by 10.000000 each.',
      diagnosis: {
        ...issue.diagnosis!,
        summary:
          'Selling availability exceeds the configured authority by 10.000000 each.',
        impact: {
          ...issue.diagnosis!.impact,
          exposedQuantity: '10.000000',
          unit: 'each',
        },
        nextSteps: [
          {
            code: 'reread_inventory',
            kind: 'read_investigate',
            text: 'Reread both mapped stock pools through scoped inventory reads.',
            evidenceRefs: [],
            preconditions: [],
            verificationCriteria: [
              'Fresh complete observations agree within the configured tolerance.',
            ],
            capabilityLimitations: [
              'Current adapters do not provide a safe write or retry capability.',
            ],
          },
          {
            code: 'manual_inventory_review',
            kind: 'manual_intervention',
            text: 'Ask an authorized operator to review correction against the left authority.',
            evidenceRefs: [],
            preconditions: [
              'Confirm current mapping, authority and available-stock semantics.',
              'Obtain current observations before correcting.',
            ],
            verificationCriteria: [
              'Reread both equivalent pools after correction and verify the intended quantity.',
            ],
            capabilityLimitations: [
              'Current adapters do not provide a safe write or retry capability.',
            ],
          },
        ],
      },
    },
  },
};

export const OverviewChecks: Story = {
  args: OverviewActions.args!,
  play: async ({ canvasElement }) => {
    const overview = within(
      within(canvasElement).getByRole('region', { name: 'Overview' }),
    );
    await expect(overview.getByText('10 units')).toBeVisible();
    await expect(
      overview.getByText(
        'Selling availability is 10 units above the configured stock authority.',
      ),
    ).toBeVisible();
    await expect(
      overview.getByText('Check current stock in both systems.', {
        selector: 'p',
      }),
    ).toBeVisible();
    await expect(
      overview.getAllByText(
        'Automatic correction and retries are not available for this issue.',
      ),
    ).toHaveLength(1);
    await expect(
      overview.getByText('Obtain current observations before correcting.'),
    ).not.toBeVisible();
    await userEvent.click(overview.getByText('Checks and verification'));
    await expect(
      overview.getByText('Obtain current observations before correcting.'),
    ).toBeVisible();
    await expect(
      overview.getByText(
        'Reread both equivalent pools after correction and verify the intended quantity.',
      ),
    ).toBeVisible();
    await expect(
      overview.queryByText(/Investigation revision/),
    ).not.toBeInTheDocument();
  },
};

export const HistoricalOverview: Story = {
  args: { item: { ...OverviewActions.args!.item!, freshness: 'stale' } },
  play: async ({ canvasElement }) => {
    const overview = within(
      within(canvasElement).getByRole('region', { name: 'Overview' }),
    );
    await expect(
      overview.getByText('Recorded potential exposure'),
    ).toBeVisible();
    await expect(
      overview.queryByText('Checks and verification'),
    ).not.toBeInTheDocument();
    await expect(
      overview.queryByText('Manual review required'),
    ).not.toBeInTheDocument();
  },
};

export const FindingsComparison: Story = {
  args: {
    item: {
      inventorySources: { left: 'jtl-onprem', right: 'shopify' },
      ...OverviewActions.args!.item!,
      diagnosis: {
        ...OverviewActions.args!.item!.diagnosis!,
        provenance: {
          ...OverviewActions.args!.item!.diagnosis!.provenance,
          evidence:
            OverviewActions.args!.item!.diagnosis!.provenance.evidence.slice(
              0,
              3,
            ),
        },
        facts: [
          {
            code: 'reported_availability',
            text: 'The left source reported 100 each; the right source reported 110 each.',
            evidenceRefs: ['shopify-stock', 'jtl-stock'],
          },
          {
            code: 'signed_difference',
            text: 'Left minus right availability is -10.000000 each.',
            evidenceRefs: ['shopify-stock', 'jtl-stock'],
          },
        ],
      },
    },
  },
};

export const FindingsEvidence: Story = {
  args: FindingsComparison.args!,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const findings = within(canvas.getByRole('region', { name: 'Findings' }));
    await expect(
      findings.getByText('100', { exact: false, selector: 'dd' }),
    ).toBeVisible();
    await expect(
      findings.getByText('110', { exact: false, selector: 'dd' }),
    ).toBeVisible();
    await expect(findings.getByText('10', { selector: 'dd' })).toBeVisible();
    await expect(findings.getByText('JTL-Wawi')).toBeVisible();
    await expect(
      findings.getByText('Shopify', { selector: 'dt' }),
    ).toBeVisible();
    await userEvent.click(findings.getByText('2 sources'));
    await expect(
      within(findings.getByText('2 sources').parentElement!).getByText(
        'shopify-stock',
      ),
    ).toBeVisible();
    await userEvent.click(findings.getByText('Possible causes · 1'));
    await expect(findings.getByText('Unconfirmed')).toBeVisible();
    await expect(
      findings.getByText(
        'Inspect sync job evidence before attributing a cause.',
      ),
    ).toBeVisible();
    const trigger = findings.getByRole('button', {
      name: 'View supporting evidence',
    });
    await userEvent.click(trigger);
    await expect(
      canvas.getByRole('heading', { name: 'Supporting evidence' }),
    ).toHaveFocus();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Back to issue' }),
    );
    await expect(trigger).toHaveFocus();
    await expect(
      findings.getByText(
        'Inspect sync job evidence before attributing a cause.',
      ),
    ).toBeVisible();
  },
};

export const ResolutionWithoutProposal: Story = { args: { noProposal: true } };

export const OverviewProduct: Story = {
  args: {
    item: {
      ...OverviewActions.args!.item!,
      productIdentities: [
        { source: 'jtl', title: 'Cotton T-shirt', sku: 'TS-BLUE-M' },
        { source: 'shopify', title: 'Cotton T-shirt', sku: 'TS-BLUE-M' },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const overview = within(
      within(canvasElement).getByRole('region', { name: 'Overview' }),
    );
    await expect(overview.getByText('Cotton T-shirt')).toBeVisible();
    await expect(overview.getAllByText('SKU: TS-BLUE-M')).toHaveLength(1);
    await expect(overview.queryByText(/SKU ID:/)).not.toBeInTheDocument();
    await expect(overview.getByText(/JTL · Shopify/)).toBeVisible();
  },
};

export const OverviewDifferentSkus: Story = {
  args: {
    item: {
      ...OverviewActions.args!.item!,
      productIdentities: [
        { source: 'jtl', title: 'Cotton T-shirt', sku: 'TS-BLUE-M' },
        { source: 'shopify', title: 'Cotton T-shirt', sku: 'BLUE-M' },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const overview = within(
      within(canvasElement).getByRole('region', { name: 'Overview' }),
    );
    await expect(
      overview.getByText('SKU: TS-BLUE-M').closest('p'),
    ).toHaveTextContent('JTL');
    await expect(
      overview.getByText('SKU: BLUE-M').closest('p'),
    ).toHaveTextContent('Shopify');
  },
};
