import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Button } from '@luma/ui/components/primitives/button';
import { cn } from '@luma/ui/lib/utils';
import { XIcon } from 'lucide-react';
import * as React from 'react';

/** Provides the shared dialog state and accessibility context for its trigger and content. */
function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/** Opens the enclosing dialog and supports a custom trigger through Base UI's render prop. */
function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

/** Mounts dialog elements in a portal outside the surrounding layout. */
function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

/** Closes the enclosing dialog and forwards Base UI close-button props. */
function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** Renders the shared modal backdrop with reduced-motion support. */
function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={(state) =>
        cn(
          'fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] transition-opacity duration-200 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-reduce:transition-none',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

/**
 * Renders portalled dialog content with an overlay and optional close button; supply a
 * DialogTitle for its accessible name.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={(state) =>
          cn(
            'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-[14px] bg-popover p-5 font-sans text-[13px] text-popover-foreground shadow-[var(--shadow-dialog)] outline-none transition-[opacity,scale] duration-200 ease-[var(--ease-standard)] data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 motion-reduce:transition-none',
            typeof className === 'function' ? className(state) : className,
          )
        }
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3 size-7"
                size="icon"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

/** Groups the dialog title and description with consistent spacing. */
function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-1 pr-10', className)}
      {...props}
    />
  );
}

/** Lays out dialog actions and optionally adds a close button. */
function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

/** Provides the enclosing dialog's accessible title with shared typography. */
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={(state) =>
        cn(
          'font-heading text-[17px] leading-6 font-semibold tracking-[-0.015em]',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

/** Provides the enclosing dialog's accessible description with shared text styling. */
function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={(state) =>
        cn(
          'text-[13px] leading-5 text-fg-muted *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
