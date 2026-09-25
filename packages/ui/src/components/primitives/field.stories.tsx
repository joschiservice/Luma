import { figmaDesign } from '@luma/ui/lib/figma';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { Field, FieldDescription, FieldError, FieldLabel } from './field';
import { Input } from './input';

function FieldExample({
  disabled = false,
  invalid = false,
}: {
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <Field className="w-80" data-disabled={disabled || undefined}>
      <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
      <Input
        id="workspace-name"
        defaultValue={invalid ? '' : 'Northstar Commerce'}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={`workspace-help${invalid ? ' workspace-error' : ''}`}
      />
      <FieldDescription id="workspace-help">
        Choose a name your team will recognize.
      </FieldDescription>
      {invalid && (
        <FieldError id="workspace-error">Enter a workspace name.</FieldError>
      )}
    </Field>
  );
}

const meta = {
  title: 'UI/Field',
  component: FieldExample,
  parameters: { design: figmaDesign('field') },
} satisfies Meta<typeof FieldExample>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Invalid: Story = { args: { invalid: true } };

export const Disabled: Story = { args: { disabled: true } };
