import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { CodeEditor } from './code-editor';

const source = `function main(input, luma) {
  const quantity = input.inputs.target - input.evidence.available;

  return { quantity: Math.max(0, quantity) };
}`;

function Editable(props: Partial<Parameters<typeof CodeEditor>[0]>) {
  const [value, setValue] = useState(source);

  return (
    <div className="w-[36rem] max-w-full">
      <CodeEditor
        label="TypeScript source"
        value={value}
        onChange={setValue}
        completions={[
          { label: 'input.inputs.target', detail: 'number' },
          { label: 'input.evidence.available', detail: 'number' },
          { label: "luma.request('create-order')", detail: 'granted action' },
        ]}
        {...props}
      />
      <output aria-label="Characters">{value.length}</output>
    </div>
  );
}

const meta = {
  title: 'UI/Code editor',
  component: Editable,
} satisfies Meta<typeof Editable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', {
      name: 'TypeScript source',
    });
    await userEvent.click(editor);
    await userEvent.keyboard('/* checked */');
    await waitFor(() =>
      expect(canvas.getByLabelText('Characters')).toHaveTextContent(
        String(source.length + '/* checked */'.length),
      ),
    );
  },
};

export const WithDiagnostics: Story = {
  args: {
    diagnostics: [
      {
        line: 2,
        severity: 'error',
        message: 'input.inputs.target is not declared.',
      },
    ],
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true },
  play: async ({ canvasElement }) => {
    const editor = await within(canvasElement).findByRole('textbox', {
      name: 'TypeScript source',
    });
    await expect(editor).toHaveAttribute('aria-readonly', 'true');
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };
