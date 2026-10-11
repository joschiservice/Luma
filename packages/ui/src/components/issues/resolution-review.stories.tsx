import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { IssuePageNavigation } from './issue-section';
import { resolutionProgress, resolutionReview } from './resolution-fixtures';
import { ResolutionReview } from './resolution-review';

const meta = {
  title: 'Cases/Resolution review',
  component: ResolutionReview,
  args: {
    review: resolutionReview,
    progress: resolutionProgress,
    connectionLabel: 'JTL · North warehouse',
    onDecision: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 650, padding: 28, background: 'var(--card)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ResolutionReview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ApprovalRequired: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByText('Approval needed')).toBeVisible();
    await expect(
      c.getByRole('button', { name: 'Approve change' }),
    ).toBeDisabled();
    await userEvent.type(
      c.getByLabelText('Reason for your decision (required)'),
      'Evidence checked',
    );
    await userEvent.click(c.getByRole('button', { name: 'Approve change' }));
    await expect(args.onDecision).toHaveBeenCalledWith(
      'approve',
      'Evidence checked',
    );
    await expect(c.getByText('Outcome check: Not checked yet')).toBeVisible();
  },
};

export const Automatic: Story = {
  args: {
    review: {
      ...resolutionReview,
      permittedDecisions: ['escalate'],
      proposal: {
        ...resolutionReview.proposal!,
        policy: {
          ...resolutionReview.proposal!.policy!,
          outcome: 'allowed',
          reason: 'This correction is within automatic execution limits.',
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('No approval needed')).toBeVisible();
    await expect(
      c.queryByRole('button', { name: 'Approve change' }),
    ).not.toBeInTheDocument();
  },
};

export const Denied: Story = {
  args: {
    review: {
      ...resolutionReview,
      permittedDecisions: ['escalate'],
      proposal: {
        ...resolutionReview.proposal!,
        policy: {
          ...resolutionReview.proposal!.policy!,
          outcome: 'denied',
          reason: 'This action exceeds the permitted risk.',
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('Not allowed by workspace rules')).toBeVisible();
    await expect(
      c.queryByRole('button', { name: 'Approve change' }),
    ).not.toBeInTheDocument();
  },
};

export const Rejected: Story = {
  args: {
    review: {
      ...resolutionReview,
      permittedDecisions: ['escalate'],
      proposal: {
        ...resolutionReview.proposal!,
        approval: {
          id: '55555555-5555-4555-8555-555555555555',
          outcome: 'rejected',
          actorId: 'operator',
          createdAt: '2026-09-20T00:00:00Z',
        },
      },
    },
  },
};

export const Approved: Story = {
  args: {
    review: {
      ...resolutionReview,
      permittedDecisions: [],
      proposal: {
        ...resolutionReview.proposal!,
        approval: {
          id: '55555555-5555-4555-8555-555555555555',
          outcome: 'approved',
          actorId: 'operator',
          createdAt: '2026-09-20T00:00:00Z',
        },
      },
    },
  },
};

export const Escalated: Story = {
  args: {
    review: { ...resolutionReview, permittedDecisions: [] },
    progress: {
      ...resolutionProgress,
      state: 'escalated',
      workflow: { availability: 'available', progress: { phase: 'escalated' } },
    },
  },
};

export const Pending: Story = {
  args: { pending: true },
  play: async ({ canvasElement }) => {
    for (const button of within(canvasElement).getAllByRole('button'))
      await expect(button).toBeDisabled();
  },
};

export const PermissionLost: Story = {
  args: { review: { ...resolutionReview, permittedDecisions: [] } },
};

export const Unavailable: Story = {
  args: {
    review: {
      ...resolutionReview,
      permittedDecisions: ['reject', 'escalate'],
      proposal: { ...resolutionReview.proposal!, available: false },
    },
  },
};

export const PageNoProposal: Story = {
  args: {
    review: {
      ...resolutionReview,
      proposal: null,
      permittedDecisions: ['escalate'],
      refreshable: true,
    },
  },
  decorators: [
    (Story) => (
      <IssuePageNavigation.Provider value={fn()}>
        <Story />
      </IssuePageNavigation.Provider>
    ),
  ],
};

export const PageEscalation: Story = {
  ...PageNoProposal,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'No change proposed' }),
    ).toBeVisible();
    await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole('region', { name: 'Change and outcome check' }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByText(/Luma checks current conditions/),
    ).not.toBeInTheDocument();
    const trigger = canvas.getByRole('button', { name: 'Escalate issue' });
    await userEvent.click(trigger);
    const reason = canvas.getByLabelText('Why does this need escalation?');
    await expect(reason).toHaveFocus();
    await expect(
      canvas.getByRole('button', { name: 'Confirm escalation' }),
    ).toBeDisabled();
    await userEvent.type(reason, 'Stock mapping needs review');
    await expect(args.onDecision).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Escalate issue' }),
    );
    await expect(
      canvas.getByLabelText('Why does this need escalation?'),
    ).toHaveValue('Stock mapping needs review');
    await userEvent.click(
      canvas.getByRole('button', { name: 'Confirm escalation' }),
    );
    await expect(args.onDecision).toHaveBeenCalledWith(
      'escalate',
      'Stock mapping needs review',
    );
  },
};

export const PageNoDecisions: Story = {
  ...PageNoProposal,
  args: {
    review: { ...resolutionReview, proposal: null, permittedDecisions: [] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole('button', { name: 'Escalate issue' }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.getByRole('button', { name: 'View recommended next step' }),
    ).toBeVisible();
  },
};

export const PageEscalationPending: Story = {
  ...PageNoProposal,
  args: { ...PageNoProposal.args!, pending: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('button', { name: 'Escalate issue' }),
    ).toBeDisabled();
  },
};

export const ObserveOnly: Story = {
  args: { review: { ...resolutionReview, observeOnly: true } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('Observe-only', { exact: true })).toBeVisible();
    await expect(
      c.getByText(/Would run when writes are enabled/),
    ).toBeVisible();
    await expect(
      c.queryByRole('button', { name: 'Approve change' }),
    ).not.toBeInTheDocument();
    await expect(c.getByText('Target system')).toBeVisible();
  },
};

export const ManualClosure: Story = {
  args: {
    review: {
      ...resolutionReview,
      proposal: null,
      permittedDecisions: ['close'],
    },
    progress: {
      ...resolutionProgress,
      workflow: { availability: 'not_started', progress: null },
    },
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Close issue' }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole(
      'dialog',
      { name: 'Close issue' },
    );
    const d = within(dialog);
    await expect(d.getByRole('button', { name: 'Close issue' })).toBeDisabled();
    await userEvent.type(
      d.getByLabelText('Reason for closing (required)'),
      'False positive',
    );
    await userEvent.click(d.getByRole('button', { name: 'Close issue' }));
    await expect(args.onDecision).toHaveBeenCalledWith(
      'close',
      'False positive',
    );
  },
};

export const ClosureWhileRunning: Story = {
  args: {
    review: { ...resolutionReview, permittedDecisions: ['close'] },
    progress: {
      ...resolutionProgress,
      workflow: { availability: 'available', progress: { phase: 'executing' } },
    },
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', {
        name: 'Close issue',
      }),
    );
    const d = within(
      within(canvasElement.ownerDocument.body).getByRole('dialog', {
        name: 'Close issue',
      }),
    );
    await userEvent.type(
      d.getByLabelText('Reason for closing (required)'),
      'Handled outside Luma',
    );
    await expect(d.getByRole('button', { name: 'Close issue' })).toBeDisabled();
    await userEvent.click(d.getByRole('checkbox'));
    await userEvent.click(d.getByRole('button', { name: 'Close issue' }));
    await expect(args.onDecision).toHaveBeenCalledWith(
      'close',
      'Handled outside Luma',
    );
  },
};
