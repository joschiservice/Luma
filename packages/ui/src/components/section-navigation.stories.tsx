import type { Meta, StoryObj } from '@storybook/react-vite';
import { Files, Info, LayoutList } from 'lucide-react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import { SectionNavigation } from './section-navigation';

const meta = {
  title: 'Components/Section navigation',
  component: SectionNavigation,
  args: {
    items: [
      { value: 'overview', label: 'Overview', icon: <LayoutList /> },
      { value: 'evidence', label: 'Evidence', icon: <Files /> },
      { value: 'details', label: 'Issue details', icon: <Info /> },
    ],
    value: 'overview',
    onValueChange: fn(),
  },
  render: function Preview(args) {
    const [value, setValue] = useState(args.value);

    return (
      <div style={{ width: 168 }}>
        <SectionNavigation {...args} value={value} onValueChange={setValue} />
      </div>
    );
  },
} satisfies Meta<typeof SectionNavigation>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutIcons: Story = {
  args: {
    items: [
      { value: 'overview', label: 'Overview' },
      { value: 'evidence', label: 'Evidence' },
      { value: 'details', label: 'Issue details' },
    ],
  },
};
