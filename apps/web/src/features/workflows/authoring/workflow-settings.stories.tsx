import type { WorkflowDraftContent } from '@luma/api-contract';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { content, validation, vocabulary } from './storybook-fixtures';
import { WorkflowSettings } from './workflow-settings';

/** Workflow settings in a Berlin workspace, showing the stored UTC start next to the form. */
function Preview() {
  const [draft, setDraft] = useState<WorkflowDraftContent>({
    ...content,
    applicability: {
      ...content.applicability,
      trigger: { kind: 'schedule', at: '2026-10-20T07:00:00.000Z' },
    },
  });
  const trigger = draft.applicability.trigger;

  return (
    <WorkspaceTimezone.Provider value="Europe/Berlin">
      <div style={{ maxWidth: 560, padding: 24 }}>
        <WorkflowSettings
          content={draft}
          validation={validation}
          vocabulary={vocabulary}
          readOnly={false}
          onChange={setDraft}
        />
        <output data-testid="stored-start">
          {trigger.kind === 'schedule' ? trigger.at : ''}
        </output>
      </div>
    </WorkspaceTimezone.Provider>
  );
}

const meta = {
  title: 'Workflows/Authoring/Settings',
  component: Preview,
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A scheduled start is entered in workspace time and stored as UTC. */
export const ScheduleInWorkspaceTime: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('Start time');
    const stored = canvas.getByTestId('stored-start');
    await expect(input).toHaveValue('2026-10-20T09:00');
    await expect(
      canvas.getByText('In the workspace time zone, Europe/Berlin.'),
    ).toBeVisible();

    await userEvent.clear(input);
    await userEvent.type(input, '2026-10-20T10:30');
    await expect(stored).toHaveTextContent('2026-10-20T08:30:00.000Z');

    // 02:30 doesn't exist in Berlin when the clocks go forward.
    await userEvent.clear(input);
    await userEvent.type(input, '2027-03-28T02:30');
    await expect(
      canvas.getByText(
        'This local time does not exist because the clocks change. Choose another time.',
      ),
    ).toBeVisible();
    await expect(stored).not.toHaveTextContent('2027-03-28');
  },
};
