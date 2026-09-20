import type { CaseProgress, CaseReview } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { CaseTimeline } from './case-timeline';

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
