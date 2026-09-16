import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Button } from '@luma/ui/button';
import { Input } from '@luma/ui/components/input';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
} from '@luma/ui/components/dialog';

it('renders shared Base UI primitives on the server without a router or desktop bridge', () => {
  const html = renderToStaticMarkup(
    <>
      <Button disabled aria-busy>
        Save changes
      </Button>
      <Input aria-label="Workspace name" defaultValue="Luma" />
      <Dialog>
        <DialogTrigger render={<Button />}>Open details</DialogTrigger>
        <DialogContent>
          <DialogTitle>Details</DialogTitle>
        </DialogContent>
      </Dialog>
    </>,
  );
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('value="Luma"');
  expect(html).toContain('Open details');
  expect(html).not.toContain('role="dialog"');
});
