import type { CaseDetail } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Button } from './button';
import { caseFixture, inventoryCase } from './case-fixtures';
import {
  CaseInvestigation,
  CaseLoading,
  CaseNotice,
} from './case-investigation';
import { IssueDetailViews } from './issue-collection';
import { IssueInspectorHeader } from './issue-inspector-header';

function InvestigationPreview({
  item,
  children,
}: {
  item?: CaseDetail | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="investigation-preview">
      {open ? (
        <section
          className="investigation-preview-panel"
          aria-label="Selected issue"
          onKeyDown={(event) => {
            if (
              event.key === 'Escape' &&
              !event.defaultPrevented &&
              !(
                event.target instanceof Element &&
                event.target.closest(
                  'input,textarea,select,[role="dialog"],[role="menu"]',
                )
              )
            ) {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <IssueDetailViews
            issueTitle={item?.summary}
            header={
              <IssueInspectorHeader
                item={item}
                fallback="Investigation"
                onClose={() => setOpen(false)}
              />
            }
          >
            <div className="investigation-preview-body">{children}</div>
          </IssueDetailViews>
        </section>
      ) : (
        <Button variant="outline" onClick={() => setOpen(true)}>
          Reopen inspector
        </Button>
      )}
    </div>
  );
}

const meta = {
  title: 'Cases/Investigation',
  component: CaseInvestigation,
  args: { item: inventoryCase, embedded: true },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story, context) => (
      <InvestigationPreview
        item={
          context.parameters.inspectorItem === false
            ? undefined
            : context.args.item
        }
      >
        <Story />
      </InvestigationPreview>
    ),
  ],
} satisfies Meta<typeof CaseInvestigation>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Inventory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', {
        name: 'Shopify shows 8 more available than JTL',
      }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: /approve/i }),
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByText('Findings & evidence'));
    const evidence = canvas
      .getByText('Shopify · Inventory', { exact: false })
      .closest('summary')!;
    evidence.focus();
    await expect(evidence).toHaveFocus();
    await userEvent.click(evidence);
    await expect(evidence.parentElement).toHaveAttribute('open');
    await expect(canvas.getAllByText('Unknown')[0]).toBeVisible();
  },
};

export const Pending: Story = { args: { item: caseFixture('pending') } };

export const MissingAuthority: Story = {
  args: { item: caseFixture('uncertain') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('More evidence is needed')).toBeVisible();
    await expect(
      canvas.queryByText(/8 units potentially exposed/),
    ).not.toBeInTheDocument();
  },
};

export const StaleEvidence: Story = {
  args: { item: caseFixture('stale') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Evidence is stale')).toBeVisible();
    await expect(
      canvas.queryByText(
        'Review authoritative JTL stock and have an authorized operator correct Shopify.',
      ),
    ).not.toBeInTheDocument();
  },
};

export const InvestigationFailed: Story = {
  args: { item: caseFixture('failed'), onRefresh: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'Investigation failed' }),
    ).toBeVisible();
    await expect(canvas.getByText('Established facts')).not.toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Check for updates' }),
    );
    await expect(args.onRefresh).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByText('Findings & evidence'));
    await expect(canvas.getByText('Established facts')).toBeVisible();
    await expect(
      canvas.queryByText(
        'Review authoritative JTL stock and have an authorized operator correct Shopify.',
      ),
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByText('Findings & evidence'));
  },
};

export const Verified: Story = { args: { item: caseFixture('resolved') } };

export const SyncFailure: Story = {
  args: { item: caseFixture('sync_failure') },
};

export const StuckFulfillment: Story = {
  args: { item: caseFixture('stuck_fulfillment') },
};

export const WorkflowFailure: Story = {
  args: { item: caseFixture('workflow_failure') },
};

export const UnknownClass: Story = { args: { item: caseFixture('unknown') } };

export const Loading: Story = {
  parameters: { inspectorItem: false },
  render: () => <CaseLoading />,
};

export const ReadFailure: Story = {
  parameters: { inspectorItem: false },
  render: () => (
    <CaseNotice error title="Case could not be refreshed">
      Refresh before relying on these findings.
    </CaseNotice>
  ),
};

export const EmptyAttention: Story = {
  parameters: { inspectorItem: false },
  render: () => (
    <CaseNotice title="Nothing needs you">
      No cases match this attention queue. Operational health depends on
      observation coverage.
    </CaseNotice>
  ),
};

export const Unobserved: Story = {
  parameters: { inspectorItem: false },
  render: () => (
    <CaseNotice title="No observations yet">
      Operational health is unknown until observations arrive.
    </CaseNotice>
  ),
};

export const Unconfirmed: Story = {
  args: { unconfirmed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('Current investigation is unconfirmed'),
    ).toBeVisible();
    await expect(
      canvas.queryByText('Evidence is stale'),
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByText(
        'Review authoritative JTL stock and have an authorized operator correct Shopify.',
      ),
    ).not.toBeInTheDocument();
  },
};

export const InvestigationFailedDark: Story = {
  args: { item: caseFixture('failed'), onRefresh: fn() },
  globals: { theme: 'dark' },
};

export const InvestigationFailedWithoutEvidence: Story = {
  args: {
    item: { ...caseFixture('failed'), diagnosis: null },
    onRefresh: fn(),
  },
};

export const InvestigationFailedUnconfirmed: Story = {
  args: { item: caseFixture('failed'), unconfirmed: true, onRefresh: fn() },
};

export const InvestigationFailedWithPreviousFindings: Story = {
  args: {
    item: { ...inventoryCase, diagnosisStatus: 'failed' },
    onRefresh: fn(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Findings & evidence'));
    await userEvent.click(canvas.getByText('Issue details'));
    await expect(
      canvas.getByText('shared-stock-pool', { selector: 'li' }),
    ).toBeVisible();
    await expect(
      canvas.queryByText(
        'Review authoritative JTL stock and have an authorized operator correct Shopify.',
      ),
    ).not.toBeInTheDocument();
  },
};

export const LongSupportingEvidence: Story = {
  args: {
    item: {
      ...inventoryCase,
      diagnosis: {
        ...inventoryCase.diagnosis!,
        provenance: {
          ...inventoryCase.diagnosis!.provenance,
          evidence: Array.from({ length: 24 }, (_, index) => ({
            ...inventoryCase.diagnosis!.provenance.evidence[0]!,
            id: `supporting-${index}`,
          })),
        },
      },
    },
  },

  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByText('Findings & evidence', { exact: true }),
    );
    const open = canvas.getByRole('button', {
      name: 'View all 24 supporting evidence records',
    });
    await userEvent.click(open);
    const collection = within(
      canvas.getByRole('region', { name: 'Supporting evidence' }),
    );
    await expect(collection.getByText('1–20 of 24')).toBeVisible();
    await userEvent.click(collection.getByRole('button', { name: 'Next' }));
    await expect(collection.getByText('21–24 of 24')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Back to issue' }),
    );
    await expect(open).toBeVisible();
    await expect(open).toHaveFocus();
  },
};
