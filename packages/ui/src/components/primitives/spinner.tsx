import { m } from '@luma/i18n/messages';
import { cn } from '@luma/ui/lib/utils';
import { Loader2Icon } from 'lucide-react';
import type { ComponentProps } from 'react';

/** Renders an animated loading indicator with a default accessible loading label. */
function Spinner({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label={m.ui_spinner_label()}
      className={cn(
        'size-4 animate-spin motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
