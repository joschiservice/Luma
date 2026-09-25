import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

/** Keeps secondary details keyboard accessible using native disclosure behavior. Include a summary as the first child. */
export function Disclosure({ className, ...props }: ComponentProps<'details'>) {
  return (
    <details
      {...props}
      data-slot="disclosure"
      className={cn('ui-disclosure', className)}
    />
  );
}
