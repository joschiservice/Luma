import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

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
    await expect(c.getByText('Human approval required')).toBeVisible();
    await expect(c.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await userEvent.type(
      c.getByLabelText('Decision reason (required)'),
      'Evidence checked',
    );
    await userEvent.click(c.getByRole('button', { name: 'Approve' }));
    await expect(args.onDecision).toHaveBeenCalledWith(
      'approve',
      'Evidence checked',
    );
    await expect(c.getByText('Verification: Not recorded')).toBeVisible();
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
    await expect(c.getByText('Automatic execution allowed')).toBeVisible();
    await expect(
      c.queryByRole('button', { name: 'Approve' }),
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
    await expect(c.getByText('Action prohibited by policy')).toBeVisible();
    await expect(
      c.queryByRole('button', { name: 'Approve' }),
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
