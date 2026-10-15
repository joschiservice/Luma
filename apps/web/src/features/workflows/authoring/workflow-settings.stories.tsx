import type { WorkflowDraftContent } from '@luma/api-contract';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, within } from 'storybook/test';

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

/** Existing scheduled definitions explain why starts are unavailable. */
export const ScheduleUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        'Scheduled starts for custom workflows are not available yet. Choose another trigger to run this workflow.',
      ),
    ).toBeVisible();
    await expect(canvas.queryByLabelText('Start time')).not.toBeInTheDocument();
  },
};
