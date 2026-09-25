import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

/** Keeps secondary details keyboard accessible using native disclosure behavior. Include a summary as the first child. */
export function Disclosure({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'details'> & { variant?: 'default' | 'plain' }) {
  return (
    <details
      {...props}
      data-slot="disclosure"
      data-variant={variant}
      className={cn('ui-disclosure', className)}
    />
  );
}
