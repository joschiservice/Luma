import type { CaseProgress, CaseReview } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { CaseTimeline } from './case-timeline';
import { IssueDetailViews } from './issue-collection';

const id = '11111111-1111-4111-8111-111111111111';

const at = '2026-09-20T04:00:00Z';

const operator: CaseReview['people'][number] = {
  kind: 'member',
  id: '99999999-9999-4999-8999-999999999999',
  name: 'Mia Keller',
  email: 'mia@example.test',
  workflow: null,
};

const luma: CaseReview['people'][number] = {
  kind: 'luma',
  id: null,
  name: null,
  email: null,
  workflow: null,
};

const progress: CaseProgress = {
  schemaVersion: 1,
  people: [operator],
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
  people: [operator],
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
    requestedBy: operator.id!,
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
  requestedBy: operator.id!,
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
        actor: operator,
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
    await expect(canvas.getByText('Not sent yet')).toBeVisible();
    await userEvent.click(canvas.getByText('Change and expected outcome'));
    await expect(canvas.getByText('Quantity')).toBeVisible();
    await expect(canvas.getByText('By Mia Keller')).toBeVisible();
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
    await expect(canvas.getByText('Accepted')).toBeVisible();
    await expect(
      canvas.getByText('Not checked yet', { exact: true }),
    ).toBeVisible();
    await expect(
      canvas.queryByText('Confirmed by a fresh check'),
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
    actorId: operator.id!,
    evidenceRefs: ['stock-after'],
  },
  workflow: { availability: 'available', progress: { phase: 'resolved' } },
};

export const VerifiedResolution: Story = {
  args: { progress: resolved },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Confirmed by a fresh check')).toBeVisible();
    await userEvent.click(canvas.getByText('Attempt 1 · Accepted'));
    await expect(canvas.getByText('Outcome check: Confirmed')).toBeVisible();
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
      canvas.getByText(/Available decisions: Escalate/),
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
        actor: luma,
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
    await expect(canvas.getByText('Current state not confirmed')).toBeVisible();
    await expect(canvas.getByText(/Last confirmed issue state/)).toBeVisible();
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
        actorId: '88888888-8888-4888-8888-888888888888',
        evidenceRefs: [],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/Closing doesn’t confirm .* · Former member/),
    ).toBeVisible();
  },
};

export const LongCollections: Story = {
  parameters: { layout: 'fullscreen' },
  args: {
    timeline: Array.from({ length: 45 }, (_, index) => ({
      ...meta.args.timeline[0]!,
      id: `event-${index}`,
      occurredAt: new Date(Date.parse(at) - index * 60_000).toISOString(),
      actor: { ...operator, name: `Operator ${index + 1}` },
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
    const history = within(canvas.getByRole('region', { name: 'History' }));
    await expect(
      canvas.getByRole('heading', { name: 'History' }),
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
    const evidence = within(canvas.getByRole('region', { name: 'Evidence' }));
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
      canvas.getByRole('region', { name: 'Evidence' }),
    ).toBeVisible();

    await userEvent.click(
      evidence.getAllByText(/JTL · Inventory/, { selector: 'summary' })[0]!,
    );
    await expect(evidence.getAllByText('sku-104')[0]!).toBeVisible();
    await userEvent.click(canvas.getByRole('heading', { name: 'Evidence' }));
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
      within(canvasElement).getByRole('region', {
        name: 'Change and outcome check',
      }),
    );
    await expect(
      section.getByRole('heading', { name: 'No change sent' }),
    ).toBeVisible();
    await expect(
      section.queryByRole('list', { name: 'Issue progress' }),
    ).not.toBeInTheDocument();
    await expect(section.queryByText('Outcome check')).not.toBeInTheDocument();
    await expect(
      section.queryByText(
        'The expected outcome isn’t available for this attempt.',
      ),
    ).not.toBeInTheDocument();
    await expect(section.getByText('Live updates')).toBeVisible();
    await userEvent.click(section.getByText('Change details'));
    await expect(section.getByText('Not started')).toBeVisible();
  },
};

export const PageApprovalWait: Story = {
  args: { expanded: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'Waiting for approval' }),
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
      canvas.getByRole('heading', { name: 'Outcome unclear' }),
    ).toBeVisible();
    await expect(
      canvas.getAllByText(
        'Luma couldn’t tell whether the change took effect. Check the record in the connected system before trying again.',
      )[0],
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
      canvas.getByRole('heading', { name: 'Checking outcome' }),
    ).toBeVisible();
    await expect(
      canvas.getByText('Accepted', { selector: 'strong' }),
    ).toBeVisible();
    await expect(
      canvas.getByText('Checking', { selector: 'strong' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('heading', { name: 'Resolved and confirmed' }),
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
      canvas.getByRole('heading', { name: 'Outcome not confirmed' }),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        'The outcome check didn’t confirm the expected result. Review the check’s evidence and the current findings.',
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
      actor: luma,
      proposalId: null,
      outcome: null,
      evidenceRefs: [],
    })).reverse(),
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
    const history = within(canvas.getByRole('region', { name: 'History' }));
    const events = history.getAllByRole('listitem');
    await expect(events).toHaveLength(3);
    const newest = within(events[0]!);
    await expect(newest.getByText('Issue observed again')).toBeVisible();
    await expect(newest.getByText(/^24 Sept? 2026 06:50$/)).toBeVisible();
    await expect(newest.getByText('By Luma')).toBeVisible();
    await expect(newest.getByText('Luma', { exact: true })).not.toBeVisible();
    await userEvent.click(newest.getByText('Event details'));
    await expect(newest.getByText('Luma', { exact: true })).toBeVisible();
    await expect(newest.getByText('2026-09-24T06:50:03.123Z')).toBeVisible();
    await userEvent.click(
      history.getByRole('button', { name: 'View full history (4)' }),
    );
    await expect(
      canvas.getByRole('heading', { name: 'History' }),
    ).toHaveFocus();
    await expect(
      within(canvas.getByRole('region', { name: 'History' })).getAllByText(
        'Issue detected',
        { selector: 'strong' },
      ),
    ).toHaveLength(1);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Back to issue' }),
    );
    await expect(newest.getByText('2026-09-24T06:50:03.123Z')).toBeVisible();
  },
};

export const PageWorkflowVerified: Story = {
  args: {
    expanded: true,
    review: { ...review, proposal: null, permittedDecisions: [] },
    progress: {
      ...progress,
      state: 'resolved',
      execution: null,
      resolution: {
        kind: 'verification',
        at,
        actorId: operator.id!,
        evidenceRefs: ['stock-after'],
      },
      workflowRuns: [
        {
          id,
          definitionId: 'shopify-stock-correction',
          name: 'Correct Shopify stock from the ERP',
          version: '1.0.0',
          truncated: false,
          steps: [
            {
              stepId: 'check-stock',
              kind: 'verification',
              state: 'completed',
              recordedAt: at,
              observedAt: at,
              evidenceRefs: ['stock-after'],
            },
          ],
          actions: [
            {
              proposalId: id,
              capability: 'inventory.available.reconcile',
              diff: {
                schemaVersion: 1,
                capability: 'inventory.available.reconcile',
                records: [
                  {
                    system: 'provider',
                    connectionId: id,
                    kind: 'inventory_item',
                    id: 'item-1',
                    changes: [
                      {
                        field: 'available',
                        before: 15,
                        beforeKnown: true,
                        after: 12,
                        afterKnown: true,
                        expected: 15,
                        expectedKnown: true,
                      },
                    ],
                  },
                ],
                scope: [{ kind: 'inventory_item', count: 1, ids: ['item-1'] }],
                reversibility: 'compensatable',
                evidence: {
                  refs: ['stock-before'],
                  observedAt: at,
                  validUntil: at,
                },
                retryProtection: 'immutable_intent_reconcile_before_retry',
                canonicalOutcome: 'requires_fresh_verification',
              },
              approval: {
                actorId: operator.id!,
                outcome: 'approved',
                createdAt: at,
              },
              execution: {
                ...execution,
                verification: {
                  outcome: 'passed',
                  observationRefs: ['stock-after'],
                  observedAt: at,
                  evaluatorVersion: 'stock-v1',
                },
              },
            },
          ],
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'Resolved and confirmed' }),
    ).toBeVisible();
    await expect(
      canvas.queryByText('Luma hasn’t sent a change for this issue.'),
    ).not.toBeInTheDocument();
    await expect(canvas.getByText(/^Approved by Mia Keller/)).toBeVisible();
    await expect(
      canvas.queryByText(
        'The expected outcome isn’t available for this attempt.',
      ),
    ).not.toBeInTheDocument();
    await expect(
      canvas.getByRole('heading', { name: 'Workflow changes and checks' }),
    ).toBeVisible();
  },
};
