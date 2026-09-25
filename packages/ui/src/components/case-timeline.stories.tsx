import type { CaseProgress, CaseReview } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { CaseTimeline } from './case-timeline';
import { IssueDetailViews } from './issue-collection';

const id = '11111111-1111-4111-8111-111111111111';

const at = '2026-09-20T04:00:00Z';

const progress: CaseProgress = {
  schemaVersion: 1,
  caseRevision: 3,
  diagnosisRevision: 1,
  state: 'awaiting_approval',
  execution: null,
  resolution: null,
  workflow: {
    availability: 'available',
    progress: { phase: 'awaiting_approval' },
  },
};

const review: CaseReview = {
  schemaVersion: 1,
  caseRevision: 3,
  diagnosisRevision: 1,
  permittedDecisions: ['approve', 'reject', 'escalate'],
  proposal: {
    id,
    version: 1,
    diagnosisRevision: 1,
    capability: 'inventory.adjust',
    capabilityVersion: '1',
    available: true,
    connectionId: id,
    target: { kind: 'inventory', id },
    parameters: { secret: 'never-render-parameters' },
    expectedPostcondition: { quantity: 4 },
    preconditions: { evidenceRefs: ['stock-before'], validUntil: at },
    risk: 'low',
    expiresAt: at,
    requestedBy: 'inventory-worker',
    policy: {
      id,
      policyVersion: 'policy-v1',
      outcome: 'approval_required',
      reason: 'Operator approval required',
      evaluatedAt: at,
      validUntil: at,
    },
    approval: null,
  },
};

const execution: NonNullable<CaseProgress['execution']> = {
  id,
  proposalId: id,
  state: 'succeeded',
  attemptId: id,
  attempt: 1,
  requestedBy: 'inventory-worker',
  executor: { kind: 'connector', id: 'shopify' },
  startedAt: at,
  finishedAt: at,
  effectEvidenceRefs: ['effect-1'],
  verification: null,
};

const meta = {
  title: 'Cases/Execution timeline',
  component: CaseTimeline,
  args: {
    progress,
    review,
    connection: 'live',
    evidence: [
      {
        id: 'stock-after',
        observedAt: at,
        sourceUpdatedAt: null,
        adapterVersion: 'shopify-v1',
        schemaVersion: 1,
        completeness: 'complete',
        source: {
          provider: 'Shopify',
          resource: 'Inventory',
          externalId: 'sku-104',
          scopeKey: 'location-1',
        },
      },
    ],
    timeline: [
      {
        id,
        type: 'execution.prepared',
        occurredAt: at,
        actorId: 'inventory-worker',
        proposalId: id,
        outcome: null,
        evidenceRefs: ['stock-before'],
      },
    ],
  },
  decorators: [
    (Story) => (
      <article
        className="case-investigation"
        style={{ maxWidth: 680, margin: 'auto', padding: 24 }}
      >
        <Story />
      </article>
    ),
  ],
} satisfies Meta<typeof CaseTimeline>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ApprovalWait: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No attempt recorded')).toBeVisible();
    await userEvent.click(canvas.getByText('Action and verification criteria'));
    await expect(canvas.getByText('Quantity')).toBeVisible();
    await expect(
      canvas.queryByText('never-render-parameters'),
    ).not.toBeInTheDocument();
  },
};

export const Executing: Story = {
  args: {
    progress: {
      ...progress,
      state: 'executing',
      execution: { ...execution, state: 'prepared', finishedAt: null },
      workflow: { availability: 'available', progress: { phase: 'executing' } },
    },
  },
};

export const Verifying: Story = {
  args: {
    progress: {
      ...progress,
      state: 'verifying',
      execution,
      workflow: { availability: 'available', progress: { phase: 'verifying' } },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Succeeded')).toBeVisible();
    await expect(
      canvas.getByText('Not recorded', { exact: true }),
    ).toBeVisible();
    await expect(
      canvas.queryByText('Recorded verified resolution'),
    ).not.toBeInTheDocument();
  },
};

const resolved: CaseProgress = {
  ...progress,
  state: 'resolved',
  execution: {
    ...execution,
    verification: {
      outcome: 'passed',
      observationRefs: ['stock-after'],
      observedAt: at,
      evaluatorVersion: 'inventory-v1',
    },
  },
  resolution: {
    kind: 'verification',
    at,
    actorId: 'verification-worker',
    evidenceRefs: ['stock-after'],
  },
  workflow: { availability: 'available', progress: { phase: 'resolved' } },
};

export const VerifiedResolution: Story = {
  args: { progress: resolved },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('Recorded verified resolution'),
    ).toBeVisible();
    await userEvent.click(canvas.getByText('Attempt 1 · Succeeded'));
    await expect(canvas.getByText('Observed result: Passed')).toBeVisible();
    const summary = canvas.getByText('Shopify · Inventory', { exact: false });
    summary.focus();
    await expect(summary).toHaveFocus();
    await userEvent.click(summary);
    await expect(canvas.getByText('sku-104')).toBeVisible();
  },
};

export const Failed: Story = {
  args: {
    progress: {
      ...progress,
      state: 'failed',
      execution: {
        ...execution,
        state: 'failed',
        verification: {
          outcome: 'failed',
          observationRefs: ['stock-after'],
          observedAt: at,
          evaluatorVersion: 'inventory-v1',
        },
      },
      workflow: { availability: 'unavailable', progress: null },
    },
    review: { ...review, permittedDecisions: ['escalate'] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/Permitted decisions: Escalate/),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: /retry/i }),
    ).not.toBeInTheDocument();
  },
};

export const Escalated: Story = {
  args: {
    progress: {
      ...progress,
      state: 'escalated',
      execution: {
        ...execution,
        state: 'unknown',
        verification: {
          outcome: 'inconclusive',
          observationRefs: [],
          observedAt: at,
          evaluatorVersion: 'inventory-v1',
        },
      },
      workflow: {
        availability: 'available',
        progress: { phase: 'escalated', reason: 'Effect remains uncertain' },
      },
    },
    review: { ...review, permittedDecisions: [] },
  },
};

export const Recovery: Story = {
  args: {
    progress: resolved,
    timeline: [
      {
        id,
        type: 'execution.reconciled',
        occurredAt: at,
        actorId: 'recovery-worker',
        proposalId: id,
        outcome: 'succeeded',
        evidenceRefs: ['stock-after'],
      },
    ],
  },
};

export const ConnectionLost: Story = {
  args: { progress: resolved, connection: 'disconnected' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('Current state is unconfirmed'),
    ).toBeVisible();
    await expect(canvas.getByText(/Last confirmed case state/)).toBeVisible();
  },
};

export const Resync: Story = {
  args: { progress: resolved, connection: 'syncing' },
};

export const HumanDisposition: Story = {
  args: {
    progress: {
      ...resolved,
      execution: null,
      resolution: {
        kind: 'human_disposition',
        at,
        actorId: 'operator',
        evidenceRefs: [],
      },
    },
  },
};

export const LongCollections: Story = {
  parameters: { layout: 'fullscreen' },
  args: {
    timeline: Array.from({ length: 45 }, (_, index) => ({
      ...meta.args.timeline[0]!,
      id: `event-${index}`,
      occurredAt: new Date(Date.parse(at) - index * 60_000).toISOString(),
      actorId: `operator-${index}`,
      type: index % 2 ? 'execution.completed' : 'execution.prepared',
      outcome: index % 2 ? 'failed' : 'succeeded',
    })),
    evidence: Array.from({ length: 24 }, (_, index) => ({
      ...meta.args.evidence[0]!,
      id: `evidence-${index}`,
      observedAt: new Date(Date.parse(at) - index * 60_000).toISOString(),
      source: {
        ...meta.args.evidence[0]!.source,
        provider: index % 2 ? 'JTL' : 'Shopify',
      },
    })),
  },
  render: (args) => (
    <div style={{ height: 600, overflowY: 'auto' }} data-testid="issue-scroll">
      <header>Selected issue</header>
      <IssueDetailViews>
        <details>
          <summary>Issue details</summary>
          <p>Keep this section open</p>
        </details>
        <CaseTimeline {...args} />
        <p>Other issue details</p>
      </IssueDetailViews>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Issue details', { exact: true }));
    await expect(canvas.getAllByText(/^By /)).toHaveLength(3);
    const open = canvas.getByRole('button', { name: 'View full history (45)' });
    open.scrollIntoView();
    const scroll = canvas.getByTestId('issue-scroll');
    const position = scroll.scrollTop;
    await userEvent.click(open);
    const history = within(
      canvas.getByRole('region', { name: 'Audit history' }),
    );
    await expect(
      canvas.getByRole('heading', { name: 'Audit history' }),
    ).toHaveFocus();
    await expect(canvas.getByText('Other issue details')).not.toBeVisible();
    await expect(history.getAllByText(/^By /)).toHaveLength(20);
    await userEvent.click(history.getByRole('button', { name: 'Next' }));
    await expect(history.getByText('21–40 of 45')).toBeVisible();
    await userEvent.click(history.getByRole('combobox', { name: 'Outcome' }));
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Failed' }),
    );
    await expect(history.getByText('1–20 of 22')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Back to issue' }),
    );
    await expect(open).toHaveFocus();
    await expect(scroll.scrollTop).toBe(position);
    await expect(canvas.getByText('Keep this section open')).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'View all 24 evidence records' }),
    );
    const evidence = within(
      canvas.getByRole('region', { name: 'Evidence provenance' }),
    );
    await userEvent.click(evidence.getByRole('combobox', { name: 'Source' }));
    await userEvent.click(
      await within(document.body).findByRole('option', {
        name: 'JTL · Inventory',
      }),
    );
    await expect(evidence.getByText('1–12 of 12')).toBeVisible();
    await userEvent.click(evidence.getByRole('combobox', { name: 'Source' }));
    await within(document.body).findByRole('listbox');
    await userEvent.keyboard('{Escape}');
    await expect(
      canvas.getByRole('region', { name: 'Evidence provenance' }),
    ).toBeVisible();

    await userEvent.click(
      evidence.getAllByText(/JTL · Inventory/, { selector: 'summary' })[0]!,
    );
    await expect(evidence.getAllByText('sku-104')[0]!).toBeVisible();
    await userEvent.click(
      canvas.getByRole('heading', { name: 'Evidence provenance' }),
    );
    await userEvent.keyboard('{Escape}');
    await expect(
      canvas.getByRole('button', { name: 'View all 24 evidence records' }),
    ).toHaveFocus();
  },
};

export const PageNotStarted: Story = {
  args: {
    expanded: true,
    progress: {
      ...progress,
      state: 'detected',
      workflow: { availability: 'not_started', progress: null },
    },
    review: { ...review, proposal: null, permittedDecisions: [] },
  },
  play: async ({ canvasElement }) => {
    const section = within(
      within(canvasElement).getByRole('region', { name: 'Execution' }),
    );
    await expect(
      section.getByRole('heading', { name: 'No execution recorded' }),
    ).toBeVisible();
    await expect(
      section.queryByRole('list', { name: 'Case lifecycle' }),
    ).not.toBeInTheDocument();
    await expect(
      section.queryByText('Outcome verification'),
    ).not.toBeInTheDocument();
    await expect(
      section.queryByText(
        'Verification criteria are not available for this attempt.',
      ),
    ).not.toBeInTheDocument();
    await expect(section.getByText('Live updates')).toBeVisible();
    await userEvent.click(section.getByText('Execution details'));
    await expect(section.getByText('Not started')).toBeVisible();
  },
};

export const PageApprovalWait: Story = {
  args: { expanded: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'Awaiting approval' }),
    ).toBeVisible();
  },
};

export const PageUnknownOutcome: Story = {
  args: {
    expanded: true,
    progress: {
      ...progress,
      state: 'executing',
      execution: { ...execution, state: 'unknown' },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'Action outcome unknown' }),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        'The action may have taken effect. Inspect fresh observations before taking further action.',
      ),
    ).toBeVisible();
  },
};

export const PageSucceededUnverified: Story = {
  args: {
    expanded: true,
    progress: { ...progress, state: 'verifying', execution },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'Verifying outcome' }),
    ).toBeVisible();
    await expect(
      canvas.getByText('Succeeded', { selector: 'strong' }),
    ).toBeVisible();
    await expect(
      canvas.getByText('Pending', { selector: 'strong' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('heading', { name: 'Resolution verified' }),
    ).not.toBeInTheDocument();
  },
};

export const PageVerificationFailed: Story = {
  args: {
    expanded: true,
    progress: {
      ...progress,
      state: 'verifying',
      execution: {
        ...execution,
        verification: {
          outcome: 'failed',
          observedAt: at,
          evaluatorVersion: 'stock-v1',
          observationRefs: ['stock-after'],
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'Verification failed' }),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        'The expected outcome was not confirmed. Review the verification evidence and current findings.',
      ),
    ).toBeVisible();
  },
};

export const PageAuditHistory: Story = {
  args: {
    expanded: true,
    timeline: Array.from({ length: 4 }, (_, index) => ({
      id: `event-${index}`,
      type: 'exception.detected',
      occurredAt: `2026-09-24T06:50:0${index}.123Z`,
      actorId: null,
      proposalId: null,
      outcome: null,
      evidenceRefs: [],
    })),
  },
  decorators: [
    (Story) => (
      <IssueDetailViews issueTitle="Inventory mismatch">
        <Story />
      </IssueDetailViews>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const history = within(
      canvas.getByRole('region', { name: 'Audit history' }),
    );
    const events = history.getAllByRole('listitem');
    await expect(events).toHaveLength(3);
    const newest = within(events[0]!);
    await expect(newest.getByText('2026-09-24 06:50:03 UTC')).toBeVisible();
    await expect(newest.getByText('Not recorded')).not.toBeVisible();
    await userEvent.click(newest.getByText('Event details'));
    await expect(newest.getByText('Not recorded')).toBeVisible();
    await expect(newest.getByText('2026-09-24T06:50:03.123Z')).toBeVisible();
    await userEvent.click(
      history.getByRole('button', { name: 'View full history (4)' }),
    );
    await expect(
      canvas.getByRole('heading', { name: 'Audit history' }),
    ).toHaveFocus();
    await expect(
      within(
        canvas.getByRole('region', { name: 'Audit history' }),
      ).getAllByText('Issue detected', { selector: 'strong' }),
    ).toHaveLength(4);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Back to issue' }),
    );
    await expect(newest.getByText('2026-09-24T06:50:03.123Z')).toBeVisible();
  },
};
