import {
  Button,
  type ButtonProps,
} from '@luma/ui/components/primitives/button';
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
import type { ReactNode } from 'react';

/**
 * Asks for confirmation before a destructive action. The caller owns `open`, so it can close
 * the dialog after the action succeeds and keep it open with `error` when it fails.
 */
export function ConfirmDialog({
  triggerLabel,
  triggerVariant = 'outline',
  disabled = false,
  title,
  description,
  confirmLabel,
  onConfirm,
  open,
  onOpenChange,
  pending,
  error,
}: {
  triggerLabel: ReactNode;
  triggerVariant?: ButtonProps['variant'];
  disabled?: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error?: string | null | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        disabled={disabled}
        render={<Button variant={triggerVariant} />}
      >
        {triggerLabel}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="sim-error-text">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
