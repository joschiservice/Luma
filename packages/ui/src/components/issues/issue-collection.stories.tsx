import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from '../primitives/button';
import { IssueCollection, IssueDetailViews } from './issue-collection';

function UpdatingCollection() {
  const [items, setItems] = useState([{ id: 'event-2' }, { id: 'event-1' }]);
  const [hasMore, setHasMore] = useState(true);

  return (
    <div>
      <Button
        onClick={() => setItems((previous) => [{ id: 'event-3' }, ...previous])}
      >
        Simulate live event
      </Button>
      <IssueDetailViews>
        <IssueCollection
          title="Audit history"
          noun="events"
          items={items}
          hasMore={hasMore}
          onLoadMore={() => {
            setItems((previous) => [...previous, { id: 'event-0' }]);
            setHasMore(false);
          }}
          renderItems={(entries) => (
            <ol>
              {entries.map((entry) => (
                <li key={entry.id}>{entry.id}</li>
              ))}
            </ol>
          )}
        />
        <details open>
          <summary>Resolution</summary>
          <p>Issue actions</p>
        </details>
      </IssueDetailViews>
    </div>
  );
}

const meta = {
  title: 'Cases/Collection navigation',
  component: UpdatingCollection,
} satisfies Meta<typeof UpdatingCollection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const UpdatesAndOlderRecords: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'View events' }));
    const collection = within(
      canvas.getByRole('region', { name: 'Audit history' }),
    );
    await expect(canvas.getByText('Issue actions')).not.toBeVisible();
    await expect(collection.getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(
      canvas.getByRole('button', { name: 'Simulate live event' }),
    );
    await expect(collection.queryByText('event-3')).not.toBeInTheDocument();
    await userEvent.click(
      collection.getByRole('button', {
        name: 'New records available · Update list',
      }),
    );
    await expect(collection.getAllByRole('listitem')).toHaveLength(3);
    await userEvent.click(
      collection.getByRole('button', { name: 'Load older events' }),
    );
    await expect(collection.getByText('event-0')).toBeVisible();
    await expect(
      collection.queryByRole('button', { name: 'Load older events' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Back to issue' }),
    );
    await expect(canvas.getByText('Issue actions')).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'View all 4 events' }),
    ).toHaveFocus();
  },
};
