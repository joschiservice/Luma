import { type ComponentProps, useCallback } from 'react';

import { cn } from '../../lib/utils';

/**
 * A native checkbox with the shared appearance. Give it a visible label or `aria-label`.
 * `indeterminate` shows a mixed state, such as when some rows of a page are selected; the native
 * input keeps keyboard, form and shift-click behavior. Coarse pointers get a 44px target.
 */
export function Checkbox({
  indeterminate = false,
  className,
  ref,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & {
  indeterminate?: boolean | undefined;
}) {
  const mixed = useCallback(
    (element: HTMLInputElement | null) => {
      if (element) element.indeterminate = indeterminate;
      if (typeof ref === 'function') ref(element);
      else if (ref) ref.current = element;
    },
    [indeterminate, ref],
  );

  return (
    <input
      {...props}
      ref={mixed}
      type="checkbox"
      data-slot="checkbox"
      className={cn('ui-checkbox', className)}
    />
  );
}
