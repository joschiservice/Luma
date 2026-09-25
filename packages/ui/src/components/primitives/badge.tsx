import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

/** Labels a state with consistent size and semantic color; always include meaningful text. */
export function Badge({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & {
  tone?: 'neutral' | 'accent' | 'info' | 'warning' | 'danger' | 'success';
}) {
  return (
    <span
      {...props}
      data-slot="badge"
      data-tone={tone}
      className={cn('ui-badge', className)}
    />
  );
}
