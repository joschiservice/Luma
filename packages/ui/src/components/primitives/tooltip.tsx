import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

/**
 * Names a control on hover and keyboard focus, for icon-only buttons. `children` is the trigger
 * element and must carry its own accessible name, because the tooltip doesn't open on touch and
 * isn't announced in place of that name.
 */
export function Tooltip({
  content,
  side = 'bottom',
  children,
}: {
  content: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger delay={400} render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          className="isolate z-50"
          side={side}
          sideOffset={6}
        >
          <TooltipPrimitive.Popup data-slot="tooltip" className="lu-tooltip">
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
