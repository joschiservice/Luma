import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  CaseInvestigation,
  CaseLoading,
  CaseNotice,
} from './case-investigation';
import { inventoryCase, caseFixture } from './case-fixtures';

const meta = {
  title: 'Cases/Investigation',
  component: CaseInvestigation,
  args: { item: inventoryCase },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 650, padding: 28, background: 'var(--card)' }}>
        <Story />
      </div>
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
        name: 'Shopify shows 8 more available than JTL.',
      }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: /approve/i }),
    ).not.toBeInTheDocument();
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
  args: { item: caseFixture('failed') },
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
export const Loading: Story = { render: () => <CaseLoading /> };
export const ReadFailure: Story = {
  render: () => (
    <CaseNotice error title="Case could not be refreshed">
      Refresh before relying on these findings.
    </CaseNotice>
  ),
};
export const EmptyAttention: Story = {
  render: () => (
    <CaseNotice title="Nothing needs you">
      No cases match this attention queue. Operational health depends on
      observation coverage.
    </CaseNotice>
  ),
};
export const Unobserved: Story = {
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
