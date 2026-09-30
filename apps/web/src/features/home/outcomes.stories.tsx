import type { OperationsOverview } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import homeStyles from './home.css?inline';
import { OutcomesModule } from './modules';

const overview: OperationsOverview = {
  generatedAt: '2026-09-30T12:00:00Z',
  window: { start: '2026-09-29T12:00:00Z', end: '2026-09-30T12:00:00Z' },
  freshnessThresholdHours: 24,
  connections: [],
  attentionCount: 0,
  activeCount: 1,
  verifiedResolutions: 3,
  automaticallyResolved: 2,
  automation: { numerator: 2, denominator: 4 },
  prioritizedDecisions: [],
  measurement: {
    environment: 'live',
    countingUnit: 'incident',
    coverage: 'complete',
    explanation: 'Recorded live detection cohort.',
    eligible: 4,
    verified: 3,
    autonomous: 2,
    human: 1,
    unknownEligibility: 0,
    unknownAttribution: 0,
    unknownEnvironment: 0,
    pending: 1,
    dataThrough: null,
  },
};
const meta = {
  title: 'Home/Resolution outcomes',
  component: OutcomesModule,
  args: { overview },
  decorators: [
    (Story) => (
      <>
        <style>
          {appStyles}
          {homeStyles}
        </style>
        <div className="home-module">
          <Story />
        </div>
      </>
    ),
  ],
} satisfies Meta<typeof OutcomesModule>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Complete: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('50%', { exact: true }),
    ).toBeVisible();
  },
};

export const UnknownAttribution: Story = {
  args: {
    overview: {
      ...overview,
      automaticallyResolved: null,
      automation: null,
      measurement: {
        ...overview.measurement!,
        coverage: 'partial',
        unknownAttribution: 2,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText('Unavailable')).toHaveLength(2);
    await expect(
      canvas.getByText('Partial measurement coverage.', { exact: false }),
    ).toBeVisible();
  },
};

export const NoEligibleIncidents: Story = {
  args: {
    overview: {
      ...overview,
      automaticallyResolved: 0,
      automation: { numerator: 0, denominator: 0 },
      measurement: {
        ...overview.measurement!,
        eligible: 0,
        autonomous: 0,
        human: 3,
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('—', { exact: true }),
    ).toBeVisible();
  },
};

export const NoClassifiedCohort: Story = {
  args: {
    overview: {
      ...overview,
      automaticallyResolved: null,
      automation: null,
      measurement: {
        ...overview.measurement!,
        coverage: 'unavailable',
        eligible: 0,
        verified: 0,
        autonomous: 0,
        human: 0,
        unknownEnvironment: 3,
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('No classified live cohort.', {
        exact: false,
      }),
    ).toBeVisible();
  },
};
