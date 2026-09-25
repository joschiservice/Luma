import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Alert, AlertDescription, AlertTitle } from './alert';
import { Badge } from './badge';
import { Button } from './button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card';
import { Disclosure } from './disclosure';
import { Empty } from './empty';

const meta = {
  title: 'UI/Content surfaces',
  component: Card,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Card>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SharedLayout: Story = {
  render: () => (
    <Card as="section" aria-label="Stock review">
      <CardHeader>
        <div>
          <CardTitle>Stock review</CardTitle>
          <CardDescription>Compare the latest observations.</CardDescription>
        </div>
        <Badge tone="warning">Review required</Badge>
      </CardHeader>
      <CardContent>
        <Alert tone="warning" role="status">
          <AlertTitle>Evidence is stale</AlertTitle>
          <AlertDescription>
            Refresh observations before choosing a correction.
          </AlertDescription>
        </Alert>
        <Disclosure>
          <summary>Supporting evidence</summary>
          <p>Shopify and JTL reported different quantities.</p>
        </Disclosure>
      </CardContent>
      <CardFooter>
        <Button>Refresh observations</Button>
      </CardFooter>
    </Card>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disclosure = canvas.getByText('Supporting evidence');
    await userEvent.click(disclosure);
    await expect(
      canvas.getByText('Shopify and JTL reported different quantities.'),
    ).toBeVisible();
    await userEvent.click(disclosure);
    await expect(
      canvas.getByText('Shopify and JTL reported different quantities.'),
    ).not.toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(
      'Evidence is stale',
    );
  },
};

export const Tones: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      {(['neutral', 'info', 'warning', 'danger', 'success'] as const).map(
        (tone) => (
          <Card key={tone}>
            <CardHeader>
              <CardTitle>{tone} state</CardTitle>
              <Badge tone={tone}>{tone}</Badge>
            </CardHeader>
            <CardContent>
              <Alert tone={tone}>
                <AlertTitle>Recorded status</AlertTitle>
                <AlertDescription>
                  Text explains the state alongside its color.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        ),
      )}
    </div>
  ),
};

export const NoResults: Story = {
  render: () => (
    <Empty>
      <h2>No matching items</h2>
      <p>Try changing your filters.</p>
      <Button variant="outline">Clear filters</Button>
    </Empty>
  ),
};
