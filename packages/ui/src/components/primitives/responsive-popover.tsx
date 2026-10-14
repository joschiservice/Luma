import { Popover } from '@base-ui/react/popover';
import { m } from '@luma/i18n/messages';
import { X } from 'lucide-react';
import { type ReactElement, type ReactNode } from 'react';

import { useSmallScreen } from '../../lib/use-small-screen';
import { Button } from './button';

/**
 * Anchors a picker to its trigger on desktop and presents a modal bottom sheet on small screens.
 * `wide` suits panels with several sections, such as display options.
 */
export function ResponsivePopover({
  trigger,
  title,
  open,
  onOpenChange,
  size = 'default',
  align = 'start',
  children,
}: {
  trigger: ReactElement;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  size?: 'default' | 'wide' | undefined;
  align?: 'start' | 'end' | undefined;
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
          align={align}
          className="ui-picker-positioner"
        >
          <Popover.Popup className="ui-picker-popup" data-size={size}>
            <div className="ui-picker-heading">
              <Popover.Title>{title}</Popover.Title>
              <Popover.Close
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={m.common_close()}
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
