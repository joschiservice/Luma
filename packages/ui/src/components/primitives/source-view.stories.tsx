import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent, userEvent, within } from 'storybook/test';

import { type CellRange, SourceSheet, SourceText } from './source-view';

const confirmation = `Order confirmation PO-2026-0412

Dear purchasing team,

we confirm 120 × LAMP-01 at EUR 14.50 per unit.
Delivery date: 2026-10-21

Kind regards
Northstar Supply`;

const cite = (id: string, quote: string) => {
  const start = confirmation.indexOf(quote);

  return { id, start, end: start + quote.length };
};

const spans = [
  cite('reference', 'PO-2026-0412'),
  cite('line', '120 × LAMP-01'),
  cite('price', 'EUR 14.50'),
  cite('date', '2026-10-21'),
];

const rows = [
  ['SKU', 'Description', 'Quantity', 'Unit price', 'Delivery'],
  ['LAMP-01', 'Desk lamp', '120', '14.50', '2026-10-21'],
  ['LAMP-02', 'Floor lamp', '40', '39.00', '2026-10-28'],
  ['SHADE-07', 'Lamp shade, linen', '200', '4.20', '2026-10-21'],
];

function TextExample() {
  const [selected, setSelected] = useState<string>('line');

  return (
    <div style={{ maxWidth: 520 }}>
      <SourceText
        label="Page 1"
        text={confirmation}
        spans={spans}
        selected={selected}
        onSelect={setSelected}
      />
      <p>Selected: {selected}</p>
    </div>
  );
}

function SheetExample() {
  const [selected, setSelected] = useState<string>('lamp');
  const [picked, setPicked] = useState<CellRange | null>(null);

  return (
    <div style={{ maxWidth: 640 }}>
      <SourceSheet
        name="Sheet Confirmation"
        rows={rows}
        ranges={[
          { id: 'lamp', row: 2, rowEnd: 2, column: 1, columnEnd: 4 },
          { id: 'shade', row: 4, rowEnd: 4, column: 1, columnEnd: 3 },
        ]}
        selected={selected}
        onSelect={setSelected}
        picked={picked}
        onPick={setPicked}
      />
      <p>
        Selected: {selected}
        {picked
          ? ` · Picked rows ${picked.row}–${picked.rowEnd}, columns ${picked.column}–${picked.columnEnd}`
          : ''}
      </p>
    </div>
  );
}

const meta = {
  title: 'UI/SourceView',
  parameters: {
    docs: {
      description: {
        component:
          'Shows document text or spreadsheet cells beside the facts that cite them. Cited parts are tinted; the selected one is outlined and scrolled into view. Text keeps its line breaks and stays selectable so people can cite new spans; cells can be picked with a click and extended with Shift-click.',
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Text: Story = {
  render: () => <TextExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('2026-10-21'));
    await expect(canvas.getByText('Selected: date')).toBeVisible();
  },
};

export const Sheet: Story = {
  render: () => <SheetExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Lamp shade, linen'));
    await expect(canvas.getByText(/Selected: shade/)).toBeVisible();
    await userEvent.click(canvas.getByText('LAMP-02'));
    await fireEvent.click(canvas.getByText('39.00'), { shiftKey: true });
    await expect(
      canvas.getByText(/Picked rows 3–3, columns 1–4/),
    ).toBeVisible();
  },
};
