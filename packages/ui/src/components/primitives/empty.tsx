import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

/** Groups an empty state's heading, explanation and optional action. */
export function Empty({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      {...props}
      data-slot="empty"
      className={cn('ui-empty', className)}
    />
  );
}
