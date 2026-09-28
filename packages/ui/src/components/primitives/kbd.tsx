import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

/** Shows a keyboard key or shortcut hint. Keep the command itself accessible elsewhere. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return <kbd {...props} className={cn('lu-kbd', className)} />;
}
