import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { type PersonOption, PersonPicker } from './person-picker';

const first = ['Alex', 'Sam', 'Lea', 'Jonas', 'Mira', 'Tom', 'Noah', 'Ida'];
const last = ['Morgan', 'Rivera', 'Braun', 'Weber', 'Fischer', 'Schulz'];

const team: PersonOption[] = [
  { id: 'self', name: 'You', detail: 'Mira Hoffmann · mira@example.com' },
  { id: 'bea', name: 'Bea Müller', detail: 'bea@example.com' },
  { id: 'casey', name: 'casey@example.com' },
  ...Array.from({ length: 297 }, (_, index) => {
    const name = `${first[index % first.length]} ${last[index % last.length]} ${index + 1}`;

    return {
      id: `person-${index}`,
      name,
      detail: `${name.toLowerCase().replaceAll(' ', '.')}@example.com`,
    };
  }),
];

const meta = {
  title: 'UI/PersonPicker',
  component: PersonPicker,
  tags: ['autodocs'],
  parameters: {
    a11y: { context: { include: ['body'] } },
    docs: {
      description: {
        component:
          'Picks one person from a workspace-sized list. Type part of a name or email; matching ignores case and accents. Arrow keys move, Enter chooses and Escape closes. Only the first matches are drawn, with a prompt to keep typing when more match.',
      },
    },
  },
  args: {
    people: team,
    label: 'Assign to…',
    title: 'Assign to a member',
    onSelect: fn(),
  },
} satisfies Meta<typeof PersonPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const page = within(document.body);
    await userEvent.click(
      within(canvasElement).getByRole('combobox', { name: 'Assign to…' }),
    );
    const list = await page.findByRole('listbox', {
      name: 'Assign to a member',
    });
    await expect(within(list).getAllByRole('option')).toHaveLength(50);
    await expect(
      page.getByText(
        'Showing 50 of 300 people. Keep typing to narrow the list.',
      ),
    ).toBeVisible();

    await userEvent.keyboard('muller');
    await waitFor(() =>
      expect(within(list).getAllByRole('option')).toHaveLength(1),
    );
    await expect(page.queryByText(/Keep typing/)).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    await expect(args.onSelect).toHaveBeenCalledWith('bea');
    await waitFor(() =>
      expect(page.queryByRole('listbox')).not.toBeInTheDocument(),
    );
  },
};

export const SearchByEmail: Story = {
  play: async ({ args, canvasElement }) => {
    const page = within(document.body);
    await userEvent.click(within(canvasElement).getByRole('combobox'));
    await userEvent.keyboard('mira@');
    const option = await page.findByRole('option', { name: /^You/ });
    await userEvent.click(option);
    await expect(args.onSelect).toHaveBeenCalledWith('self');
  },
};

export const NoMatches: Story = {
  play: async ({ canvasElement }) => {
    const page = within(document.body);
    await userEvent.click(within(canvasElement).getByRole('combobox'));
    await userEvent.keyboard('nobody here');
    await expect(
      await page.findByText('No people match your search'),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(page.queryByRole('listbox')).not.toBeInTheDocument(),
    );
  },
};

export const ShortList: Story = {
  args: { people: team.slice(0, 3) },
  play: async ({ canvasElement }) => {
    const page = within(document.body);
    await userEvent.click(within(canvasElement).getByRole('combobox'));
    await expect(await page.findAllByRole('option')).toHaveLength(3);
    await expect(page.queryByText(/Keep typing/)).not.toBeInTheDocument();
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('combobox')).toBeDisabled();
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('combobox'));
    await within(document.body).findByRole('listbox');
  },
};

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('combobox'));
    await within(document.body).findByRole('listbox');
  },
};
