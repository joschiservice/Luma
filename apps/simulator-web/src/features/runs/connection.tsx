import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/primitives/dialog';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { KeyRound } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';

import { defaultToken } from '../../api';
import { useConnection } from '../../queries';

function TokenForm({
  onSaved,
  footer,
}: {
  onSaved?: () => void;
  footer?: (submit: string) => ReactNode;
}) {
  const { token, changeToken } = useConnection();
  const [value, setValue] = useState(token);
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    changeToken(value.trim() || defaultToken);
    onSaved?.();
  };

  return (
    <form id={`${id}-form`} className="sim-form" onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor={id}>Access token</FieldLabel>
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          aria-describedby={`${id}-description`}
        />
        <FieldDescription id={`${id}-description`}>
          Kept for this browser tab only. A local simulator accepts{' '}
          <code>{defaultToken}</code> unless it was started with another token.
        </FieldDescription>
      </Field>
      {footer ? (
        footer(`${id}-form`)
      ) : (
        <div className="sim-actions">
          <Button type="submit">Connect</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setValue(defaultToken)}
          >
            Use the local default
          </Button>
        </div>
      )}
    </form>
  );
}

/** Explains why the simulator can't be read and lets the person change the token. */
export function ConnectPanel({
  reason,
}: {
  reason: 'rejected' | 'unreachable';
}) {
  return (
    <Card as="section" aria-labelledby="connect-title" className="sim-connect">
      <CardHeader>
        <div>
          <CardTitle id="connect-title">Connect to the simulator</CardTitle>
          <CardDescription role="alert">
            {reason === 'rejected'
              ? 'The simulator rejected the access token. Enter the token it was started with.'
              : 'The simulator is unreachable. Start it with pnpm simulator, then try again; the page reconnects automatically.'}
          </CardDescription>
        </div>
      </CardHeader>
      <TokenForm />
    </Card>
  );
}

/** Changes the access token from the top bar. */
export function TokenDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" />}>
        <KeyRound aria-hidden="true" />
        Access token
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Access token</DialogTitle>
          <DialogDescription>
            Every request to the simulator sends this bearer token.
          </DialogDescription>
        </DialogHeader>
        <TokenForm
          onSaved={() => setOpen(false)}
          footer={(form) => (
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit" form={form}>
                Save token
              </Button>
            </DialogFooter>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}
