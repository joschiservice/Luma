import { Popover } from '@base-ui/react/popover';
import { X } from 'lucide-react';
import { type ReactElement, type ReactNode } from 'react';

import { useSmallScreen } from '../../lib/use-small-screen';
import { Button } from './button';

/** Anchors a picker to its trigger on desktop and presents a modal bottom sheet on small screens. */
export function ResponsivePopover({
  trigger,
  title,
  open,
  onOpenChange,
  children,
}: {
  trigger: ReactElement;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const mobile = useSmallScreen();

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal={mobile}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        {mobile && <Popover.Backdrop className="ui-picker-backdrop" />}
        <Popover.Positioner
          sideOffset={6}
          align="start"
          className="ui-picker-positioner"
        >
          <Popover.Popup className="ui-picker-popup">
            <div className="ui-picker-heading">
              <Popover.Title>{title}</Popover.Title>
              <Popover.Close
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close picker"
                  />
                }
              >
                <X aria-hidden="true" />
              </Popover.Close>
            </div>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
