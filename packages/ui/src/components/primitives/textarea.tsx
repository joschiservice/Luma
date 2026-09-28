import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';
import { controlClassName } from './input';

/** Provides a resizable multiline input with shared focus, validation and disabled styling. */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(controlClassName, 'min-h-24 py-2 leading-5', className)}
      {...props}
    />
  );
}
